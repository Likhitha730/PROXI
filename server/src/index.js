// Server bootstrap: Express app + Socket.IO attached to the same HTTP server,
// optional MongoDB connection, and graceful shutdown.
//
// Run with: npm run dev:server   (watch mode)
//           npm start            (plain, used in production)

import http from 'node:http'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Server } from 'socket.io'
import { createApp } from './app.js'
import { config as defaultConfig, createOriginValidator } from './config/env.js'
import { createLogger } from './lib/logger.js'
import { registerSocketHandlers } from './sockets/handlers.js'
import { createPlayerRegistry } from './realtime/registry.js'
import { createPositionsRepository } from './db/positions.js'
import { createSpatialCheck } from './realtime/spatialCheck.js'
import { getDatabase } from './db/mongo.js'
import { closeDatabase, connectDatabase } from './db/mongo.js'

/** Builds the app, HTTP server and Socket.IO instance without listening. */
/** How often the database proximity path is cross-checked against the live grid. */
const CHECK_INTERVAL_MS = 30_000

export function createServer({
  config = defaultConfig,
  logger = createLogger({ level: defaultConfig.logLevel }),
  // Injection point: production passes the real handle (the default), tests pass a
  // double so the persistence code path can be exercised without a MongoDB server.
  getDatabase: getDatabaseHandle = getDatabase,
} = {}) {
  const app = createApp({ config, logger })
  /** Background work started by main(); tests never call it. */
  const pendingStartup = []
  const httpServer = http.createServer(app)

  const io = new Server(httpServer, {
    path: '/socket.io',
    // The client bundle ships socket.io-client, so serving the legacy client
    // script from the server is unnecessary surface.
    serveClient: false,
    transports: ['websocket', 'polling'],
    cors: {
      origin: createOriginValidator(config.corsOrigins),
      methods: ['GET', 'POST'],
      credentials: false,
    },
    // Realtime payloads are tiny; anything larger is a client bug or an attack.
    maxHttpBufferSize: 100_000,
  })

  // One registry per server instance, owned here so tests and future services
  // (proximity, persistence) can inspect the same authoritative presence table.
  const registry = createPlayerRegistry()

  // Positions repository: persistence only. Its queries read the archive; live
  // presence is always the registry, so the realtime path never waits on MongoDB.
  const positions = createPositionsRepository({
    getDatabase: getDatabaseHandle,
    collectionName: config.mongoCollection,
    logger,
  })

  const realtime = registerSocketHandlers(io, { logger, config, registry, positions })

  // Slow cross-check that the planar database query and the in-memory grid agree.
  const spatialCheck = createSpatialCheck({ proximity: realtime.proximity, positions, registry, logger })

  /**
   * Register background work (database connection, index creation, pruning) without
   * starting it. `createServer` deliberately starts nothing: tests build servers
   * without touching MongoDB, and `main()` runs the queued work once the HTTP
   * listener is up.
   */
  function deferStartup(task) {
    pendingStartup.push(task)
    return task
  }

  /** Run everything queued with `deferStartup`. A failing task is reported, never thrown. */
  async function runStartupTasks() {
    return Promise.all(pendingStartup.map((task) => Promise.resolve(task).catch((error) => {
      logger.warn('startup task failed', { reason: error?.message })
      return null
    })))
  }

  return {
    app,
    httpServer,
    io,
    logger,
    config,
    registry,
    realtime,
    positions,
    spatialCheck,
    deferStartup,
    runStartupTasks,
  }
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => resolve())
    // Drop keep-alive/idle sockets so shutdown is not held hostage by them.
    server.closeIdleConnections?.()
    setTimeout(() => server.closeAllConnections?.(), 0).unref?.()
  })
}

export function installShutdownHandlers({ httpServer, io, logger, config, positions = null, registry = null }) {
  let shuttingDown = false

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) {
      logger.warn('shutdown already in progress', { signal })
      return
    }
    shuttingDown = true
    logger.info('shutdown requested', { signal })

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit', { timeoutMs: config.shutdownTimeoutMs })
      process.exit(1)
    }, config.shutdownTimeoutMs)
    force.unref?.()

    try {
      // Flush live positions so a restart does not lose the last few seconds of
      // movement, then close in order: sockets, HTTP, database.
      if (positions && registry) {
        const records = registry.list().map((player) => ({
          sessionId: player.id,
          name: player.name,
          x: player.x,
          y: player.y,
          connected: true,
        }))
        if (records.length > 0) {
          const flushed = await positions.saveMany(records)
          logger.info('flushed live positions', { players: records.length, ok: flushed?.ok !== false })
        }
      }
      await new Promise((resolve) => io.close(() => resolve()))
      await closeHttpServer(httpServer)
      await closeDatabase()
      clearTimeout(force)
      logger.info('shutdown complete')
      process.exit(exitCode)
    } catch (error) {
      clearTimeout(force)
      logger.error('error during shutdown', { reason: error?.message })
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) })
  })
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception — shutting down', { reason: error?.message })
    shutdown('uncaughtException', 1)
  })

  return shutdown
}

async function main() {
  const logger = createLogger({ level: defaultConfig.logLevel, scope: 'server' })
  const { httpServer, io, positions, spatialCheck, registry, deferStartup, runStartupTasks } = createServer({
    config: defaultConfig,
    logger,
  })

  // Persistence is optional: connecting runs in the background and is never
  // awaited, so an unreachable cluster cannot delay or fail startup. Index creation
  // and the archive prune run only once the connection actually succeeds.
  deferStartup(
    connectDatabase({ uri: defaultConfig.mongoUri, dbName: defaultConfig.mongoDb, logger }).then(async (database) => {
      if (!database) return null
      const status = await positions.ensureIndexes()
      logger.info('position indexes ready', {
        created: status.created?.length ?? 0,
        present: status.present?.length ?? 0,
        conflicts: status.conflicts ?? [],
      })
      const pruned = await positions.pruneStale({ maxAgeMs: 60 * 60 * 1000 })
      if (pruned?.deletedCount) logger.info('pruned stale position records', { removed: pruned.deletedCount })
      return database
    }),
  )

  // The consistency check only does anything while a database is available.
  const checkTimer = setInterval(() => {
    spatialCheck.runOnce().catch((error) => logger.warn('spatial check failed', { reason: error?.message }))
  }, CHECK_INTERVAL_MS)
  checkTimer.unref?.()

  installShutdownHandlers({ httpServer, io, logger, config: defaultConfig, positions, registry })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(defaultConfig.port, defaultConfig.host, resolve)
  })

  runStartupTasks() // connection, indexes and prune: reported, never blocking

  logger.info('ProxiSpeak server ready', {
    host: defaultConfig.host,
    port: defaultConfig.port,
    environment: defaultConfig.nodeEnv,
    corsOrigins: defaultConfig.corsOrigins.length,
    health: `http://127.0.0.1:${defaultConfig.port}/api/health`,
  })
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    const logger = createLogger({ level: defaultConfig.logLevel, scope: 'server' })
    logger.error('failed to start server', { reason: error?.message })
    process.exit(1)
  })
}
