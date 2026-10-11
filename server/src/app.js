// Express application factory (no listening, no Socket.IO wiring here) so the
// app can be created and exercised in tests without opening a port.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createCorsMiddleware, createErrorHandler, notFoundHandler } from './middleware/http.js'
import { createHealthRouter } from './routes/health.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIST = path.resolve(here, '../../client/dist')

function mountClientBuild(app, { config, logger }) {
  if (!config.isProduction) return

  const indexFile = path.join(CLIENT_DIST, 'index.html')
  if (!existsSync(indexFile)) {
    logger.warn('client build not found — run "npm run build" before "npm start"', { expected: CLIENT_DIST })
    return
  }

  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }))
  // Single-page application fallback for non-API, non-socket routes.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next()
    return res.sendFile(indexFile)
  })
  logger.info('serving client build', { directory: 'client/dist' })
}

export function createApp({ config, logger }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use(createCorsMiddleware(config.corsOrigins))
  app.use(express.json({ limit: '16kb' }))

  app.use('/api', createHealthRouter({ config }))
  app.get('/api', (_req, res) => {
    res.json({
      service: config.appName,
      version: config.version,
      endpoints: ['/api/health'],
    })
  })

  mountClientBuild(app, { config, logger })

  app.use(notFoundHandler)
  app.use(createErrorHandler({ logger }))

  return app
}
