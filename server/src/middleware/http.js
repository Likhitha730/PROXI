// Shared Express middleware: CORS allow-list, JSON 404s and the error handler.

import { isOriginAllowed } from '../config/env.js'

const ALLOWED_METHODS = 'GET,POST,OPTIONS'
const ALLOWED_HEADERS = 'Content-Type,Accept'

/**
 * CORS driven entirely by the CORS_ORIGIN environment variable (comma-separated
 * exact origins, or "*" as an explicit opt-in). Requests from other origins get
 * no CORS headers, and their preflights are rejected with 403.
 */
export function createCorsMiddleware(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin
    res.setHeader('Vary', 'Origin')

    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
      res.setHeader('Access-Control-Max-Age', '600')
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = isOriginAllowed(origin, allowedOrigins) ? 204 : 403
      return res.end()
    }

    return next()
  }
}

/** Unknown API routes answer with JSON so clients never parse an HTML error page. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  })
}

/** Last-resort error handler: logs the stack, returns a generic JSON payload. */
export function createErrorHandler({ logger }) {
  // Express identifies error handlers by their 4-argument arity — `_next` must stay.
  return (error, req, res, _next) => {
    logger.error('unhandled request error', { method: req.method, path: req.path, reason: error?.message })
    if (res.headersSent) return
    res.status(500).json({
      error: { code: 'internal_error', message: 'Unexpected server error' },
    })
  }
}
