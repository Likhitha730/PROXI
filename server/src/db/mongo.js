// MongoDB integration placeholder.
//
// This milestone deliberately implements **connection plumbing only**: no
// collections, no indexes, no geospatial queries (those belong to the
// persistence milestone). Everything here is optional by design:
//
//   * no MONGODB_URI  → status "disabled", the realtime server runs normally
//   * unreachable URI → status "error", logged, never thrown and never blocking
//
// The health endpoint reports only a coarse status string — never the URI.

import { MongoClient } from 'mongodb'

const DISABLED_REASON = 'no connection string configured'

let client = null
let database = null
let status = Object.freeze({ status: 'disabled', message: DISABLED_REASON })
let connecting = null

function setStatus(next) {
  status = Object.freeze(next)
}

/** Coarse, secret-free status for the health endpoint and logs. */
export function getDatabaseStatus() {
  return { ...status }
}

/** The connected Db handle, or null when persistence is disabled/unavailable. */
export function getDatabase() {
  return database
}

/**
 * Starts the connection in the background. Resolves to the Db handle or null.
 * Never rejects: persistence must not be able to crash or stall the server.
 */
export async function connectDatabase({ uri, dbName, logger } = {}) {
  if (!uri) {
    setStatus({ status: 'disabled', message: DISABLED_REASON })
    logger?.warn('persistence disabled', { reason: DISABLED_REASON })
    return null
  }

  if (connecting) return connecting

  setStatus({ status: 'connecting' })
  logger?.info('connecting to MongoDB Atlas')

  connecting = (async () => {
    try {
      const candidate = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        retryWrites: true,
      })
      await candidate.connect()
      await candidate.db(dbName).command({ ping: 1 })
      client = candidate
      database = candidate.db(dbName)
      setStatus({ status: 'connected', database: dbName })
      logger?.info('MongoDB connected', { database: dbName })
      return database
    } catch (error) {
      // Note: the logger redacts the URI, so this is safe to log.
      setStatus({ status: 'error', message: 'MongoDB connection failed' })
      logger?.error('MongoDB connection failed', { reason: error?.message })
      client = null
      database = null
      return null
    } finally {
      connecting = null
    }
  })()

  return connecting
}

/** Closes the driver; safe to call when persistence was never enabled. */
export async function closeDatabase() {
  if (!client) return
  const active = client
  client = null
  database = null
  setStatus({ status: 'disabled', message: 'connection closed' })
  try {
    await active.close()
  } catch {
    // Closing a broken client must not break shutdown.
  }
}

/** Test helper: forget any cached state without touching the network. */
export function resetDatabaseStateForTests() {
  client = null
  database = null
  connecting = null
  setStatus({ status: 'disabled', message: DISABLED_REASON })
}
