// Server configuration: one place that reads, validates and freezes environment
// values. `parseConfig` is pure so it can be unit tested without touching
// `process.env`; `config` is the validated instance used by the application.
//
// Rule: secrets live only here and are never written into HTTP responses.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import dotenv from 'dotenv'

// Loads `server/.env` (cwd is the server package when started via npm scripts).
// Missing file is not an error: every key has a default below.
dotenv.config({ quiet: true })

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const APP_NAME = 'proxispeak-server'
export const APP_VERSION = pkg.version

export const DEFAULTS = Object.freeze({
  PORT: '8080',
  HOST: '0.0.0.0',
  NODE_ENV: 'development',
  CORS_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173',
  LOG_LEVEL: 'info',
  SHUTDOWN_TIMEOUT_MS: '10000',
  MONGODB_DB: 'proxispeak',
})

const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug'])

function read(source, key) {
  const raw = source[key]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** `"a, b ,,c"` → `["a","b","c"]`; empty input falls back to the dev defaults. */
export function parseOriginList(value, fallback = DEFAULTS.CORS_ORIGIN) {
  const source = value === undefined || value === null || String(value).trim() === '' ? fallback : value
  return String(source)
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

function parseInteger(value, { key, fallback, min, max }) {
  const raw = value ?? fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || String(parsed) !== String(raw).trim() || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max} (received ${JSON.stringify(value)})`)
  }
  return parsed
}

/**
 * Validate a raw environment object into a frozen config object.
 * Throws on invalid values: the process must fail loudly, never silently default.
 */
export function parseConfig(source = {}) {
  const nodeEnv = read(source, 'NODE_ENV') ?? DEFAULTS.NODE_ENV
  const logLevel = read(source, 'LOG_LEVEL') ?? DEFAULTS.LOG_LEVEL
  if (!VALID_LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${[...VALID_LOG_LEVELS].join(', ')} (received ${logLevel})`)
  }

  const corsOrigins = parseOriginList(source.CORS_ORIGIN)

  return Object.freeze({
    appName: APP_NAME,
    version: APP_VERSION,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: read(source, 'HOST') ?? DEFAULTS.HOST,
    port: parseInteger(source.PORT, { key: 'PORT', fallback: DEFAULTS.PORT, min: 1, max: 65535 }),
    shutdownTimeoutMs: parseInteger(source.SHUTDOWN_TIMEOUT_MS, {
      key: 'SHUTDOWN_TIMEOUT_MS',
      fallback: DEFAULTS.SHUTDOWN_TIMEOUT_MS,
      min: 0,
      max: 120_000,
    }),
    logLevel,
    corsOrigins: Object.freeze(corsOrigins),
    mongoUri: read(source, 'MONGODB_URI') ?? null,
    mongoDb: read(source, 'MONGODB_DB') ?? DEFAULTS.MONGODB_DB,
  })
}

/** True when the origin may talk to the API. `*` is the explicit opt-in wildcard. */
export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true // same-origin requests, curl, server-to-server
  if (allowedOrigins.includes('*')) return true
  return allowedOrigins.includes(origin)
}

/** Callback-style validator shared by the CORS middleware and Socket.IO. */
export function createOriginValidator(allowedOrigins) {
  return (origin, callback) => {
    if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true)
    return callback(new Error(`Origin ${origin} is not allowed`))
  }
}

export const config = parseConfig(process.env)
