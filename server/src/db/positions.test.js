// Persistence tests: schema, planar query shape, and repository behaviour.
//
// These run against `src/test/fakeMongo.js`, a documented double that implements the
// legacy `2d` query surface (ascending planar distance for `$near`, `$center` for
// `$geoWithin`) and the driver's error codes. The tests therefore prove the *query
// documents* and the repository's own logic; they do not claim anything about a real
// server's performance (see docs/SESSION_05_REPORT.md).

import { beforeEach, describe, expect, it } from 'vitest'
import { createPositionsRepository } from './positions.js'
import { createFakeDatabase, mongoErrors } from '../test/fakeMongo.js'
import { INDEX_BOUNDS, POSITIONS_SCHEMA_VERSION, buildPositionDocument, positionsIndexSpecs } from './schema.js'
import { LIMITS } from '../../../shared/protocol.js'
import { createWorldLogger } from '../test/silentLogger.js'

const COLLECTION = 'positions'

let fake
let repository
let logger

function connect({ failWith } = {}) {
  fake = createFakeDatabase({ failWith })
  repository = createPositionsRepository({
    getDatabase: () => fake.database,
    collectionName: COLLECTION,
    logger,
  })
  return repository
}

const seed = (players) =>
  fake.seed(
    COLLECTION,
    players.map((player) => ({
      sessionId: player.id,
      name: player.name,
      location: [player.x, player.y],
      connected: player.connected ?? true,
      schemaVersion: POSITIONS_SCHEMA_VERSION,
      updatedAt: player.updatedAt ?? new Date(),
    })),
  )

beforeEach(() => {
  logger = createWorldLogger()
  connect()
})

describe('schema', () => {
  it('stores planar [x, y] pairs, never GeoJSON', () => {
    const document = buildPositionDocument({
      sessionId: 'session-1',
      name: 'Ada',
      x: 1280.456,
      y: 1500.654,
      now: new Date('2026-01-01T00:00:00Z'),
    })

    expect(document).toEqual({
      sessionId: 'session-1',
      name: 'Ada',
      location: [1280.456, 1500.654],
      connected: true,
      schemaVersion: POSITIONS_SCHEMA_VERSION,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    expect(document.location).toBeInstanceOf(Array)
    expect(document.location).not.toHaveProperty('type')
    expect(document.location).not.toHaveProperty('coordinates')
  })

  it('declares a 2d index with planar bounds, a unique session key and a TTL', () => {
    const specs = positionsIndexSpecs({ ttlSeconds: 3600 })
    const byName = Object.fromEntries(specs.map((spec) => [spec.name, spec]))

    expect(byName.location_2d.key).toEqual({ location: '2d' })
    expect(byName.location_2d.options).toMatchObject({ min: INDEX_BOUNDS.min, max: INDEX_BOUNDS.max })
    // 2d, explicitly NOT 2dsphere: spherical indexing would treat pixels as degrees.
    expect(JSON.stringify(byName.location_2d.key)).not.toMatch(/2dsphere/)

    expect(byName.sessionId_unique.key).toEqual({ sessionId: 1 })
    expect(byName.sessionId_unique.options.unique).toBe(true)

    expect(byName.updatedAt_ttl.key).toEqual({ updatedAt: 1 })
    expect(byName.updatedAt_ttl.options.expireAfterSeconds).toBe(3600)
  })

  it('can create every declared index on a fresh database', async () => {
    const report = await repository.ensureIndexes()
    expect(report.error).toBeUndefined()
    expect(report.created.sort()).toEqual(['location_2d', 'sessionId_unique', 'updatedAt_ttl'])

    const indexes = fake.indexesIn(COLLECTION)
    expect(indexes.find((index) => index.name === 'location_2d')).toMatchObject({ min: 0, max: 2560 })
  })
})

describe('writing positions', () => {
  it('upserts one document per session, flagged as connected', async () => {
    const result = await repository.savePosition({ sessionId: 'session-1', name: 'Ada', x: 1280, y: 1500 })
    expect(result.ok).not.toBe(false)

    const [document] = fake.documentsIn(COLLECTION)
    expect(document).toMatchObject({
      sessionId: 'session-1',
      name: 'Ada',
      location: [1280, 1500],
      connected: true,
    })
    expect(document.firstSeenAt).toBeInstanceOf(Date)
  })

  it('updates in place on a second write (no duplicate sessions)', async () => {
    await repository.savePosition({ sessionId: 'session-1', name: 'Ada', x: 1280, y: 1500 })
    await repository.savePosition({ sessionId: 'session-1', name: 'Ada', x: 1200, y: 1450 })

    const documents = fake.documentsIn(COLLECTION)
    expect(documents).toHaveLength(1)
    expect(documents[0].location).toEqual([1200, 1450])
    // firstSeenAt is preserved, updatedAt moves
    expect(documents[0].firstSeenAt.getTime()).toBeLessThanOrEqual(documents[0].updatedAt.getTime())
  })

  it('flags a session as disconnected without deleting the record', async () => {
    await repository.savePosition({ sessionId: 'session-1', name: 'Ada', x: 1280, y: 1500 })
    await repository.markDisconnected('session-1')

    const [document] = fake.documentsIn(COLLECTION)
    expect(document.connected).toBe(false)
  })

  it('writes many positions in one bulk operation (shutdown flush)', async () => {
    await repository.saveMany([
      { sessionId: 'a', name: 'Ada', x: 100, y: 100, connected: true },
      { sessionId: 'b', name: 'Grace', x: 200, y: 200, connected: true },
    ])
    expect(fake.callsOf('bulkWrite')).toHaveLength(1)
    expect(fake.documentsIn(COLLECTION)).toHaveLength(2)
  })

  it('counts writes and prunes stale disconnected records', async () => {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000)
    seed([
      { id: 'live', name: 'Live', x: 100, y: 100, updatedAt: new Date() },
      { id: 'gone', name: 'Gone', x: 120, y: 100, connected: false, updatedAt: old },
    ])

    const pruned = await repository.pruneStale({ maxAgeMs: 60 * 60 * 1000 })
    expect(pruned.deletedCount).toBe(1)
    expect(fake.documentsIn(COLLECTION).map((document) => document.sessionId)).toEqual(['live'])
    expect(await repository.count({ connected: true })).toBe(1)
  })
})

describe('planar proximity queries', () => {
  beforeEach(() => {
    seed([
      { id: 'self', name: 'Self', x: 1000, y: 1000 },
      { id: 'close', name: 'Close', x: 1050, y: 1000 },
      { id: 'edge', name: 'Edge', x: 1100, y: 1000 }, // exactly 100 u away
      { id: 'beyond', name: 'Beyond', x: 1200, y: 1000 },
      { id: 'diagonal', name: 'Diagonal', x: 1030, y: 1040 }, // 50 u
    ])
  })

  it('emits a legacy-pair $near query with an explicit maxDistance', async () => {
    const result = await repository.findNearby({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })
    expect(result.ok).toBe(true)

    // The exact query document the driver receives — asserted so a refactor cannot
    // silently swap the planar form for a GeoJSON one.
    expect(result.query).toEqual({
      location: { $near: [1000, 1000], $maxDistance: 100 },
      connected: true,
      updatedAt: { $gte: expect.any(Date) },
      sessionId: { $ne: 'self' },
    })
  })

  it('returns neighbours ordered by planar distance, self excluded', async () => {
    const result = await repository.findNearby({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })

    const distances = result.neighbours.map((entry) => entry.distance)
    // ascending, tolerating ties (two records sit exactly 50 u away)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
    expect(distances.map((distance) => Math.round(distance))).toEqual([50, 50, 100])
    expect(new Set(result.neighbours.map((entry) => entry.sessionId))).toEqual(new Set(['close', 'diagonal', 'edge']))
    expect(result.neighbours.some((entry) => entry.sessionId === 'self')).toBe(false)
  })

  it('includes a point exactly on the radius and excludes one beyond it', async () => {
    const result = await repository.findNearby({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })
    const ids = result.neighbours.map((entry) => entry.sessionId)
    expect(ids).toContain('edge') // distance === radius is inside (inclusive boundary)
    expect(ids).not.toContain('beyond')
  })

  it('returns an empty list when nobody is in range', async () => {
    const result = await repository.findNearby({ x: 300, y: 300, radius: 100, excludeSessionId: 'self' })
    expect(result.neighbours).toEqual([])
  })

  it('reports each neighbour’s current position and distance', async () => {
    const result = await repository.findNearby({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })
    const close = result.neighbours.find((entry) => entry.sessionId === 'close')
    expect(close).toMatchObject({ name: 'Close', x: 1050, y: 1000 })
    expect(close.distance).toBeCloseTo(50, 6)
  })

  it('never returns duplicates, even with several records inside the radius', async () => {
    seed([
      { id: 'near-1', name: 'One', x: 1010, y: 1000 },
      { id: 'near-2', name: 'Two', x: 1020, y: 1000 },
      { id: 'near-3', name: 'Three', x: 1030, y: 1000 },
    ])
    const result = await repository.findNearby({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })
    const ids = result.neighbours.map((entry) => entry.sessionId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('excludes disconnected and stale records — they are not active users', async () => {
    // A separate corner of the office, so the shared fixture cannot interfere.
    seed([
      { id: 'disconnected', name: 'Gone', x: 610, y: 600, connected: false },
      { id: 'stale', name: 'Stale', x: 620, y: 600, updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
      { id: 'fresh', name: 'Fresh', x: 630, y: 600, updatedAt: new Date() },
    ])

    const result = await repository.findNearby({ x: 600, y: 600, radius: 100, excludeSessionId: 'self', maxAgeMs: 60_000 })
    expect(result.neighbours.map((entry) => entry.sessionId)).toEqual(['fresh'])
  })

  it('can intersect the archive with the authoritative live session set', async () => {
    seed([{ id: 'ghost', name: 'Ghost', x: 710, y: 700 }])
    const result = await repository.findNearby({
      x: 700,
      y: 700,
      radius: 100,
      excludeSessionId: 'self',
      activeSessionIds: new Set(['ghost', 'someone-else']),
    })
    // 'ghost' is the only in-range record and it IS live here, so it survives...
    expect(result.neighbours.map((entry) => entry.sessionId)).toEqual(['ghost'])

    // ...but a set of live ids that does not include it filters it out, which is how a
    // stale archive row is prevented from posing as an active nearby user.
    const filtered = await repository.findNearby({
      x: 700,
      y: 700,
      radius: 100,
      excludeSessionId: 'self',
      activeSessionIds: new Set(['someone-else']),
    })
    expect(filtered.neighbours).toEqual([])
  })

  it('supports the unordered $geoWithin/$center form as well', async () => {
    const result = await repository.findWithinBox({ x: 1000, y: 1000, radius: 100, excludeSessionId: 'self' })
    expect(result.query).toEqual({
      location: { $geoWithin: { $center: [[1000, 1000], 100] } },
      sessionId: { $ne: 'self' },
    })
    expect(result.sessionIds.sort()).toEqual(['close', 'diagonal', 'edge'])
  })

  it('uses the documented default radius constant', () => {
    expect(LIMITS.PROXIMITY_RADIUS).toBe(100)
  })
})

describe('database unavailability', () => {
  it('reports unavailable instead of throwing when there is no connection', async () => {
    const offline = createPositionsRepository({ getDatabase: () => null, collectionName: COLLECTION, logger })
    expect(offline.isAvailable()).toBe(false)

    const write = await offline.savePosition({ sessionId: 's', name: 'Ada', x: 1, y: 1 })
    expect(write).toEqual({ ok: false, reason: 'database unavailable' })

    const query = await offline.findNearby({ x: 0, y: 0, radius: 100 })
    expect(query.ok).toBe(false)

    const indexes = await offline.ensureIndexes()
    expect(indexes.ok).toBe(false)
    expect(offline.stats.skippedWrites).toBe(1)
  })

  it('degrades to unavailable results when the driver throws mid-operation', async () => {
    connect({ failWith: (operation) => (operation === 'updateOne' || operation === 'find' ? mongoErrors.timeout() : null) })

    const write = await repository.savePosition({ sessionId: 's', name: 'Ada', x: 10, y: 10 })
    expect(write.ok).toBe(false)
    expect(repository.stats.failures).toBe(1)

    const query = await repository.findNearby({ x: 10, y: 10, radius: 100 })
    expect(query.ok).toBe(false)
    expect(repository.stats.failures).toBe(2)
  })

  it('keeps working after a connection comes back', async () => {
    let available = false
    const dynamic = createPositionsRepository({
      getDatabase: () => (available ? fake.database : null),
      collectionName: COLLECTION,
      logger,
    })

    expect(await dynamic.savePosition({ sessionId: 's', name: 'Ada', x: 1, y: 1 })).toEqual({
      ok: false,
      reason: 'database unavailable',
    })

    available = true
    await dynamic.savePosition({ sessionId: 's', name: 'Ada', x: 40, y: 40 })
    expect(fake.documentsIn(COLLECTION)).toHaveLength(1)
  })

  it('never logs the connection string (only coarse reasons)', async () => {
    connect({ failWith: () => mongoErrors.notConnected() })
    await repository.savePosition({ sessionId: 's', name: 'Ada', x: 1, y: 1 })

    const logged = JSON.stringify(logger.records)
    expect(logged).not.toMatch(/mongodb(\+srv)?:\/\//)
    expect(logged).not.toMatch(/MONGODB_URI/)
    expect(logged).toMatch(/Client must be connected/)
  })
})
