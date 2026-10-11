// Positions repository — the persistence half of presence.
//
// Division of labour (important, and the reason the two never conflict):
//
//   * the **registry** (`realtime/registry.js`) owns *live* state: who is connected
//     right now, what the server last accepted, in memory, authoritative;
//   * the **positions collection** owns the *archive*: where sessions were, written
//     at a low frequency (default every 2 s per player, plus on join and leave).
//
// Proximity for the realtime path is computed from the registry, because a database
// round trip has no place in a 4 Hz loop and because disconnected players must not
// appear as "nearby" the instant their socket dies. The planar `2d` query exposed
// here (`findNearby`) is the database-side strategy: it answers "who was within R of
// this point" from persisted data, is used by the spatial consistency check, and is
// what analytics or a cold-start presence map would use.
//
// Every method degrades gracefully: with no database, they resolve to
// `{ ok: false, reason: 'unavailable' }` shaped results rather than throwing, so the
// socket handlers never need a try/catch around persistence.

import { POSITION_TTL_SECONDS, buildPositionDocument, positionsIndexSpecs } from './schema.js'
import { ensureIndexes } from './indexes.js'

const UNAVAILABLE = Object.freeze({ ok: false, reason: 'database unavailable' })

/**
 * @param {{
 *   getDatabase: () => object | null,
 *   collectionName?: string,
 *   logger?: object,
 *   ttlSeconds?: number,
 *   now?: () => Date,
 * }} deps
 */
export function createPositionsRepository({
  getDatabase,
  collectionName = 'positions',
  logger,
  ttlSeconds = POSITION_TTL_SECONDS,
  now = () => new Date(),
} = {}) {
  const specs = positionsIndexSpecs({ ttlSeconds })
  const stats = { writes: 0, removals: 0, reads: 0, failures: 0, indexRuns: 0, skippedWrites: 0 }

  function collection() {
    const database = getDatabase?.()
    if (!database) return null
    try {
      return database.collection(collectionName)
    } catch (error) {
      logger?.warn('could not open collection', { collection: collectionName, reason: error?.message })
      return null
    }
  }

  /** Wrap a driver call so a database failure can never escape into the app. */
  async function guarded(operation, run) {
    try {
      return await run()
    } catch (error) {
      stats.failures += 1
      logger?.warn('position store operation failed', {
        operation,
        reason: error?.message ?? 'unknown error',
        code: error?.codeName ?? error?.code,
      })
      return UNAVAILABLE
    }
  }

  return {
    stats,
    collectionName,
    specs,

    /** The exact index documents this repository expects (documentation + tests). */
    indexSpecs() {
      return specs
    },

    /** Idempotent: safe on every connect. Never throws. */
    async ensureIndexes() {
      const active = collection()
      if (!active) return { ...UNAVAILABLE, created: [], present: [], conflicts: [] }
      stats.indexRuns += 1
      return guarded('ensureIndexes', () => ensureIndexes({ collection: active, specs, logger }))
    },

    /**
     * Upsert one session's position. `sessionId` is the server-minted player id, so
     * a reconnect creates a new record rather than resurrecting an old one.
     */
    async savePosition({ sessionId, name, x, y, connected = true }) {
      const active = collection()
      if (!active) {
        stats.skippedWrites += 1
        return UNAVAILABLE
      }

      const at = now()
      const document = buildPositionDocument({ sessionId, name, x, y, connected, now: at })
      const result = await guarded('savePosition', () =>
        active.updateOne(
          { sessionId },
          {
            $set: document,
            $setOnInsert: { firstSeenAt: at },
          },
          { upsert: true },
        ),
      )
      if (result.ok !== false) stats.writes += 1
      return result
    },

    /** Write many sessions at once (used on graceful shutdown). */
    async saveMany(records = []) {
      const active = collection()
      if (!active || records.length === 0) {
        stats.skippedWrites += records.length
        return UNAVAILABLE
      }

      const at = now()
      const operations = records.map((record) => ({
        updateOne: {
          filter: { sessionId: record.sessionId },
          update: {
            $set: buildPositionDocument({ ...record, now: at }),
            $setOnInsert: { firstSeenAt: at },
          },
          upsert: true,
        },
      }))

      const result = await guarded('saveMany', () => active.bulkWrite(operations, { ordered: false }))
      if (result.ok !== false) stats.writes += records.length
      return result
    },

    /**
     * Mark a session as gone. The record is kept (as history) but flagged, so a
     * database-side proximity query can exclude it. `pruneStale` eventually removes
     * the rest, and the TTL index collects anything left behind.
     */
    async markDisconnected(sessionId) {
      const active = collection()
      if (!active) return UNAVAILABLE
      const at = now()
      const result = await guarded('markDisconnected', () =>
        active.updateOne(
          { sessionId },
          { $set: { connected: false, updatedAt: at }, $setOnInsert: { firstSeenAt: at } },
          { upsert: false },
        ),
      )
      if (result.ok !== false) stats.removals += 1
      return result
    },

    /**
     * PLANAR proximity query — the database-side spatial strategy.
     *
     * `$near` on a 2d index returns documents ordered by Euclidean distance in
     * index units (world units here), filtered by `$maxDistance`. The legacy pair
     * form is used deliberately: no GeoJSON, no spherical interpretation.
     *
     * Filters applied on top:
     *   * `connected: true` and `updatedAt >= now - maxAgeMs` — a stale or
     *     disconnected record is not an "active nearby user";
     *   * `sessionId: { $ne: excludeSessionId }` — the caller is never their own
     *     neighbour;
     *   * a `set` of known live session ids, when supplied, so the result can be
     *     intersected with the authoritative registry (dedupe + liveness in one step).
     *
     * @returns {Promise<{ ok: true, neighbours: Array<{sessionId: string, name: string, x: number, y: number, distance: number}>, query: object }
     *                  | { ok: false, reason: string }>}
     */
    async findNearby({ x, y, radius, excludeSessionId = null, activeSessionIds = null, maxAgeMs = 60_000, limit = 0 }) {
      const active = collection()
      if (!active) return UNAVAILABLE

      const filter = {
        location: { $near: [x, y], $maxDistance: radius },
        connected: true,
        updatedAt: { $gte: new Date(now().getTime() - maxAgeMs) },
      }
      if (activeSessionIds) {
        // Intersecting with the live registry already excludes the caller (it is
        // live), so the filter stays a single operator per field.
        const live = [...activeSessionIds].filter((id) => id !== excludeSessionId)
        filter.sessionId = { $in: live }
      } else if (excludeSessionId) {
        filter.sessionId = { $ne: excludeSessionId }
      }

      const cursor = active.find(filter, limit > 0 ? { limit } : {})
      const result = await guarded('findNearby', () => cursor.toArray())
      if (result.ok === false) return result
      stats.reads += 1

      const neighbours = (result ?? [])
        .map((document) => {
          const [documentX, documentY] = document.location ?? []
          return {
            sessionId: document.sessionId,
            name: document.name ?? 'Guest',
            x: documentX,
            y: documentY,
            distance: Math.hypot(documentX - x, documentY - y),
          }
        })
        // Distance is recomputed in application code: `$near` orders by distance but
        // does not project it, and the rounding must match the in-memory engine.
        .sort((a, b) => a.distance - b.distance)

      return { ok: true, neighbours, query: filter }
    },

    /** Unordered set query (no distance sort) — the `$geoWithin`/`$center` form. */
    async findWithinBox({ x, y, radius, excludeSessionId = null }) {
      const active = collection()
      if (!active) return UNAVAILABLE

      const filter = { location: { $geoWithin: { $center: [[x, y], radius] } } }
      if (excludeSessionId) filter.sessionId = { $ne: excludeSessionId }

      const result = await guarded('findWithinBox', () => active.find(filter).toArray())
      if (result.ok === false) return result
      stats.reads += 1
      return {
        ok: true,
        sessionIds: result.map((document) => document.sessionId),
        query: filter,
      }
    },

    /** How many records the archive holds (health/diagnostics only). */
    async count(filter = {}) {
      const active = collection()
      if (!active) return null
      const result = await guarded('count', () => active.countDocuments(filter))
      return result.ok === false ? null : result
    },

    /**
     * Delete records for sessions that are no longer connected and have not been
     * touched within `maxAgeMs`. Used at startup and on a slow interval; the TTL
     * index is the backstop.
     */
    async pruneStale({ maxAgeMs = 60 * 60 * 1000 } = {}) {
      const active = collection()
      if (!active) return UNAVAILABLE
      return guarded('pruneStale', () =>
        active.deleteMany({
          connected: false,
          updatedAt: { $lt: new Date(now().getTime() - maxAgeMs) },
        }),
      )
    },

    /** True when a database handle is available right now. */
    isAvailable() {
      return Boolean(collection())
    },
  }
}
