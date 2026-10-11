// Index management tests: creation must be idempotent, conflicts must be reported
// rather than fatal, and a broken database must never stop the server.

import { describe, expect, it } from 'vitest'
import { ensureIndexes } from './indexes.js'
import { createFakeDatabase, mongoErrors } from '../test/fakeMongo.js'
import { INDEX_BOUNDS, positionsIndexSpecs } from './schema.js'
import { createWorldLogger } from '../test/silentLogger.js'

const COLLECTION = 'positions'
const specs = positionsIndexSpecs({ ttlSeconds: 3600 })

function setup({ existingIndexes = [], failWith } = {}) {
  const fake = createFakeDatabase({ existingIndexes, failWith })
  const logger = createWorldLogger()
  return { fake, logger, collection: fake.database.collection(COLLECTION) }
}

describe('ensureIndexes', () => {
  it('creates the planar 2d index, the unique session index and the TTL index', async () => {
    const { fake, collection, logger } = setup()
    const report = await ensureIndexes({ collection, specs, logger })

    expect(report.created.sort()).toEqual(['location_2d', 'sessionId_unique', 'updatedAt_ttl'])
    expect(report.present).toEqual([])
    expect(report.conflicts).toEqual([])

    const indexes = fake.indexesIn(COLLECTION)
    expect(indexes.find((index) => index.name === 'location_2d')).toMatchObject({
      key: { location: '2d' },
      min: INDEX_BOUNDS.min,
      max: INDEX_BOUNDS.max,
    })
  })

  it('is idempotent: a second run creates nothing and reports what is present', async () => {
    const { fake, collection, logger } = setup()
    await ensureIndexes({ collection, specs, logger })
    const before = fake.callsOf('createIndex').length

    const second = await ensureIndexes({ collection, specs, logger })

    expect(second.created).toEqual([])
    expect(second.present.sort()).toEqual(['location_2d', 'sessionId_unique', 'updatedAt_ttl'])
    expect(fake.callsOf('createIndex').length).toBe(before) // no DDL the second time
    expect(fake.indexesIn(COLLECTION)).toHaveLength(3)
  })

  it('reports an existing index with different options instead of dropping it', async () => {
    // A deployment where someone created the same key with a different TTL.
    const { fake, collection, logger } = setup({
      existingIndexes: [{ name: 'updatedAt_ttl', key: { updatedAt: 1 }, expireAfterSeconds: 60 }],
    })

    const report = await ensureIndexes({ collection, specs, logger })

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatch(/updatedAt_ttl/)
    expect(report.conflicts[0]).toMatch(/expireAfterSeconds/)
    expect(report.created).not.toContain('updatedAt_ttl') // no competing index created
    // The existing index is left exactly as it was: never dropped automatically.
    const untouched = fake.indexesIn(COLLECTION).find((index) => index.name === 'updatedAt_ttl')
    expect(untouched.expireAfterSeconds).toBe(60)
    // ...while the two indexes that were missing are still created.
    expect(report.created.sort()).toEqual(['location_2d', 'sessionId_unique'])
    expect(logger.records.some((record) => record.level === 'warn' && /different options/.test(record.message))).toBe(true)
  })

  it('treats a matching existing index as present, not as a conflict', async () => {
    const { fake, collection, logger } = setup({
      existingIndexes: [{ name: 'location_2d', key: { location: '2d' }, min: 0, max: 2560 }],
    })

    const report = await ensureIndexes({ collection, specs, logger })
    expect(report.present).toContain('location_2d')
    expect(report.conflicts).toEqual([])
    expect(report.created.sort()).toEqual(['sessionId_unique', 'updatedAt_ttl'])
    // Exactly one index on the location key — the existing one was reused, not replaced.
    expect(fake.indexesIn(COLLECTION).filter((index) => 'location' in index.key)).toHaveLength(1)
  })

  it('handles a concurrent creation (code 68) without failing', async () => {
    const conflict = new Error('Index already exists with a different name')
    conflict.code = 68
    conflict.codeName = 'IndexAlreadyExists'

    const { collection, logger } = setup({ failWith: (operation) => (operation === 'createIndex' ? conflict : null) })
    const report = await ensureIndexes({ collection, specs, logger })

    expect(report.created).toEqual([])
    expect(report.conflicts).toHaveLength(3) // one per spec, all reported
    expect(report.error).toBeUndefined()
  })

  it('reports a generic index failure without throwing', async () => {
    const { collection, logger } = setup({ failWith: (operation) => (operation === 'createIndex' ? mongoErrors.timeout() : null) })
    const report = await ensureIndexes({ collection, specs, logger })

    expect(report.error).toMatch(/connection timed out/)
    expect(report.created).toEqual([])
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true)
  })

  it('tolerates a namespace that does not exist yet (fresh database)', async () => {
    const notFound = new Error('ns not found')
    notFound.code = 26
    notFound.codeName = 'NamespaceNotFound'
    const { collection, logger } = setup({ failWith: (operation) => (operation === 'listIndexes' ? notFound : null) })

    const report = await ensureIndexes({ collection, specs, logger })
    expect(report.skipped).toBe('collection does not exist yet')
    expect(report.created.sort()).toEqual(['location_2d', 'sessionId_unique', 'updatedAt_ttl'])
  })

  it('never throws, whatever the database does', async () => {
    const { collection, logger } = setup({ failWith: () => new Error('totally broken') })
    await expect(ensureIndexes({ collection, specs, logger })).resolves.toBeTruthy()
  })
})
