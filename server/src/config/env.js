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
  MONGODB_COLLECTION: 'positions',
  PROXIMITY_RADIUS: '100',
  POSITION_FLUSH_MS: '2000',
  /**
   * A public STUN server is enough for the common case (two browsers behind
   * ordinary home routers). It is NOT enough for symmetric NAT or restrictive
   * corporate networks — those need a TURN relay, configured below.
   */
  ICE_STUN_URLS: 'stun:stun.l.google.com:19302',
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

/** `"stun:a, turn:b"` → `["stun:a","turn:b"]`, dropping anything not stun/turn. */
export function parseIceUrls(value, { key, fallback = '', schemes = ['stun', 'turn', 'turns'] } = {}) {
  const raw = value === undefined || value === null ? fallback : String(value)
  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const url of urls) {
    if (!schemes.some((scheme) => url.toLowerCase().startsWith(`${scheme}:`))) {
      throw new Error(`${key} entries must start with ${schemes.join('/')} (received ${JSON.stringify(url)})`)
    }
  }
  return urls
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
    mongoCollection: read(source, 'MONGODB_COLLECTION') ?? DEFAULTS.MONGODB_COLLECTION,
    /** Listening radius in world units (planar, not metres). */
    proximityRadius: parseInteger(source.PROXIMITY_RADIUS, {
      key: 'PROXIMITY_RADIUS',
      fallback: DEFAULTS.PROXIMITY_RADIUS,
      min: 1,
      max: 2000,
    }),
    /** How often a moving player's position is written to MongoDB. */
    positionFlushMs: parseInteger(source.POSITION_FLUSH_MS, {
      key: 'POSITION_FLUSH_MS',
      fallback: DEFAULTS.POSITION_FLUSH_MS,
      min: 250,
      max: 60_000,
    }),

    /*
     * ICE / WebRTC connectivity.
     *
     * These are handed to browsers by GET /api/ice (they cannot work otherwise),
     * which is exactly why TURN credentials must be ephemeral: generate short-lived
     * ones and rotate them. They are never logged, and never committed — see
     * server/.env.example.
     */
    iceStunUrls: Object.freeze(
      parseIceUrls(source.ICE_STUN_URLS, { key: 'ICE_STUN_URLS', fallback: DEFAULTS.ICE_STUN_URLS, schemes: ['stun'] }),
    ),
    iceTurnUrl: (() => {
      const url = read(source, 'ICE_TURN_URL') ?? null
      if (url === null) return null
      return parseIceUrls(url, { key: 'ICE_TURN_URL', schemes: ['turn', 'turns'] })[0] ?? null
    })(),
    iceTurnUsername: read(source, 'ICE_TURN_USERNAME') ?? null,
    iceTurnCredential: read(source, 'ICE_TURN_CREDENTIAL') ?? null,
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
