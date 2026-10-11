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
import { closeDatabase, connectDatabase } from './db/mongo.js'

/** Builds the app, HTTP server and Socket.IO instance without listening. */
export function createServer({ config = defaultConfig, logger = createLogger({ level: defaultConfig.logLevel }) } = {}) {
  const app = createApp({ config, logger })
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
  const realtime = registerSocketHandlers(io, { logger, config, registry })

  return { app, httpServer, io, logger, config, registry, realtime }
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

export function installShutdownHandlers({ httpServer, io, logger, config }) {
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
  const { httpServer, io } = createServer({ config: defaultConfig, logger })

  // Persistence is optional in this milestone: started in the background and
  // never awaited, so an unreachable cluster cannot delay or fail startup.
  connectDatabase({ uri: defaultConfig.mongoUri, dbName: defaultConfig.mongoDb, logger })

  installShutdownHandlers({ httpServer, io, logger, config: defaultConfig })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(defaultConfig.port, defaultConfig.host, resolve)
  })

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
