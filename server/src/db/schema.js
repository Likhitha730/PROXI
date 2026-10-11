// MongoDB schema and index definitions for position persistence.
//
// ============================================================================
// SPATIAL MODEL — planar 2D, NOT latitude/longitude
// ============================================================================
//
// ProxiSpeak's office is a flat, y-down pixel plane: 2560 x 1600 world units,
// where 1 unit = 1 CSS pixel at zoom 1 (see docs/ARCHITECTURE.md §3). Coordinates
// like [1280, 1500] are NOT degrees. Treating them as geography would be wrong in
// two visible ways:
//
//   * a `2dsphere` index interprets a GeoJSON Point as longitude/latitude on a
//     sphere, so distances are metric (metres) and meridians converge — a 100-unit
//     "radius" would mean something different in the corner of the map;
//   * GeoJSON validation rejects latitudes outside [-90, 90], and our y axis runs
//     to 1600 — the data would not even index.
//
// So the chosen representation is the **legacy coordinate pair** indexed with a
// **`2d` index** (the planar one):
//
//   { location: [x, y] }                       // array of two numbers: [x, y]
//   db.positions.createIndex({ location: '2d' }, { min: 0, max: 2560 })
//
// Legacy `2d` indexes are planar by definition: distances are Euclidean in index
// units, `$maxDistance` is measured in those same units, and there is no spherical
// wrapping. One index unit == one world unit == one CSS pixel, which is exactly
// what the proximity engine needs. Queries therefore use the legacy pair form of
// `$near` / `$geoWithin` (`{ $near: [x, y], $maxDistance: r }`,
// `{ $geoWithin: { $center: [[x, y], r] } }`) and never wrap coordinates in a
// GeoJSON `Point`.
//
// The `min`/`max` bounds are the world's larger dimension: MongoDB's 2d index
// range is square, so both axes share `[0, 2560]`. The y axis (0..1600) simply
// occupies the lower part of that range. `min` is 0 rather than a negative value
// because every stored position has already been validated into the walkable
// world (x,y >= 32) before it reaches the database.
//
// ============================================================================
// COLLECTION: positions
// ============================================================================
//
// One document per *session* (a connected player), upserted while they move:
//
//   {
//     _id:          ObjectId,        // server-generated
//     sessionId:    string,          // server-minted player id (UUID) — the identity
//     name:         string,          // display name at the time of the write
//     location:     [number, number],// PLANAR [x, y] in world units (2d-indexed)
//     connected:    boolean,         // false once the session is gone
//     schemaVersion: 1,              // lets a future reader migrate documents
//     firstSeenAt:  Date,            // when this session was first persisted
//     updatedAt:    Date             // last accepted position write
//   }
//
// Indexes:
//   1. { location: '2d', min: 0, max: 2560 }          — planar proximity queries
//   2. { sessionId: 1 } unique                        — one live record per session,
//                                                       and makes the upsert idempotent
//   3. { updatedAt: 1 } TTL (expireAfterSeconds)      — stale records cannot pile up;
//                                                       transient presence lives in
//                                                       memory, the DB is the archive
//
// Index creation is idempotent: `createIndex` is a no-op when an identical index
// already exists, and index creation itself is retried on the next connection. An
// existing index with the same key but *different* options raises
// IndexOptionsConflict (85) / IndexKeySpecsConflict (86); those are reported as a
// warning and the index is left untouched rather than dropped — dropping an index
// on a live deployment is not something a startup path should ever do silently.

/** Schema version written into every document (bump when the shape changes). */
export const POSITIONS_SCHEMA_VERSION = 1

/** World bounds used by the 2d index range (the world's larger dimension). */
export const INDEX_BOUNDS = Object.freeze({ min: 0, max: 2560 })

/** Default retention for persisted positions (transient presence is in memory). */
export const POSITION_TTL_SECONDS = 60 * 60 * 24 // 24 h

/**
 * Index specifications for the positions collection.
 *
 * @param {{ ttlSeconds?: number }} [options]
 * @returns {Array<{ name: string, key: Record<string, unknown>, options: Record<string, unknown>, purpose: string }>}
 */
export function positionsIndexSpecs({ ttlSeconds = POSITION_TTL_SECONDS } = {}) {
  return [
    {
      name: 'location_2d',
      key: { location: '2d' },
      options: { min: INDEX_BOUNDS.min, max: INDEX_BOUNDS.max },
      purpose: 'planar proximity queries ($near / $geoWithin) in world units',
    },
    {
      name: 'sessionId_unique',
      key: { sessionId: 1 },
      options: { unique: true },
      purpose: 'one live record per session; makes the position upsert idempotent',
    },
    {
      name: 'updatedAt_ttl',
      key: { updatedAt: 1 },
      options: { expireAfterSeconds: ttlSeconds },
      purpose: 'expire stale records so the collection cannot grow without bound',
    },
  ]
}

/**
 * Two specs describe the same index when the key is identical — MongoDB allows only
 * one index per key pattern, so options differences must be handled, not created.
 */
export function sameIndexKey(a, b) {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y))
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y))
  if (left.length !== right.length) return false
  return left.every(([key, value], index) => right[index][0] === key && String(right[index][1]) === String(value))
}

/**
 * Compare a desired spec with an existing index document and report what differs.
 *
 * @returns {{ matches: boolean, differences: string[] }}
 */
export function compareIndex(spec, existing) {
  const differences = []
  if (!sameIndexKey(spec.key, existing.key ?? {})) differences.push('key')

  const wanted = spec.options ?? {}
  for (const option of ['unique', 'min', 'max', 'expireAfterSeconds']) {
    if (!(option in wanted)) continue
    if (String(existing[option]) !== String(wanted[option])) {
      differences.push(`${option}: existing=${existing[option]} wanted=${wanted[option]}`)
    }
  }
  if (spec.options?.name && existing.name !== spec.name) {
    // A name mismatch alone is harmless as long as the key and options match.
    differences.push(`name: existing=${existing.name} wanted=${spec.name}`)
  }
  return { matches: differences.filter((entry) => !entry.startsWith('name:')).length === 0, differences }
}

/**
 * The document written for a player position. Keeps the persisted shape in one
 * place so the repository and the tests cannot drift.
 */
export function buildPositionDocument({ sessionId, name, x, y, connected = true, now = new Date() }) {
  return {
    sessionId,
    name,
    // Legacy coordinate pair, planar: [x, y]. Never GeoJSON.
    location: [x, y],
    connected,
    schemaVersion: POSITIONS_SCHEMA_VERSION,
    updatedAt: now,
  }
}
