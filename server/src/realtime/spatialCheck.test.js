// The consistency check compares the two proximity strategies: the live grid
// (registry state) and the archive (planar $near over persisted documents).
// It must report agreement, report differences clearly, and never throw.

import { describe, expect, it } from 'vitest'
import { createSpatialCheck } from './spatialCheck.js'
import { createPlayerRegistry } from './registry.js'
import { createProximityEngine } from './proximity.js'
import { createWorldLogger } from '../test/silentLogger.js'

let idCounter = 0

/** A positions repository double whose findNearby result the test controls. */
function fakePositions(neighbours, { ok = true, available = true } = {}) {
  const calls = []
  return {
    calls,
    isAvailable: () => available,
    findNearby: async (query) => {
      calls.push(query)
      if (!ok) return { ok: false, reason: 'database unavailable' }
      return { ok: true, neighbours, query: { collection: 'positions', filter: { location: { $near: [query.x, query.y] } } } }
    },
  }
}

function setup({ neighbours, ok, available, players = [] } = {}) {
  const registry = createPlayerRegistry({ idFactory: () => `id-${++idCounter}`, now: () => 5000 })
  players.forEach(({ socketId, name, x, y }) => {
    registry.add({ socketId, name })
    registry.move(socketId, { x, y, moving: false })
  })
  const proximity = createProximityEngine({ registry, onUpdate: () => {} })
  const resolved = typeof neighbours === 'function' ? neighbours(registry) : neighbours
  const positions = fakePositions(resolved, { ok, available })
  const logger = createWorldLogger()
  const check = createSpatialCheck({ proximity, positions, registry, logger, now: () => 123456 })
  return { registry, proximity, positions, logger, check }
}

const neighbour = (sessionId, distance = 10) => ({ sessionId, name: sessionId, x: 0, y: 0, distance, connected: true })

describe('spatial consistency check', () => {
  it('reports agreement when both strategies see the same live players', async () => {
    const { registry, check } = setup({
      players: [
        { socketId: 'a', name: 'Ada', x: 1000, y: 1000 },
        { socketId: 'b', name: 'Grace', x: 1030, y: 1000 },
      ],
      // The archive returns the very id the registry minted for socket b.
      neighbours: (live) => [neighbour(live.get('b').id)],
    })

    const result = await check.compare({ x: 1000, y: 1000, excludeSessionId: registry.get('a').id })

    expect(result.ok).toBe(true)
    expect(result.differences).toEqual([])
    expect(result.database.count).toBe(1)
    expect(result.memory.count).toBe(1)
    expect(check.stats.agreements).toBe(1)
  })

  it('reports a player the archive has not caught up with (the expected lag)', async () => {
    const { registry, check, logger } = setup({
      players: [
        { socketId: 'a', name: 'Ada', x: 1000, y: 1000 },
        { socketId: 'b', name: 'Grace', x: 1030, y: 1000 },
      ],
      neighbours: [], // archive is behind: the flush has not happened yet
    })

    const result = await check.compare({ x: 1000, y: 1000, excludeSessionId: registry.get('a').id })

    expect(result.ok).toBe(false)
    expect(result.differences).toEqual([`missing in database: ${registry.get('b').id}`])
    expect(check.stats.differences).toBe(1)
    const warning = logger.records.find((record) => record.level === 'warn')
    expect(warning.message).toMatch(/disagree/)
    expect(warning.meta.note).toMatch(/lag/)
  })

  it('reports a database row that is no longer live in memory', async () => {
    const { registry, check } = setup({
      players: [{ socketId: 'a', name: 'Ada', x: 1000, y: 1000 }],
      neighbours: [neighbour('ghost-session')],
    })

    const result = await check.compare({ x: 1000, y: 1000, excludeSessionId: registry.get('a').id })
    expect(result.differences).toEqual(['missing in memory: ghost-session'])
    expect(check.stats.differences).toBe(1)
  })

  it('skips cleanly when the database is unavailable', async () => {
    const { check } = setup({ available: false })
    const result = await check.compare({ x: 0, y: 0 })

    expect(result).toEqual({ ok: false, reason: 'database unavailable' })
    expect(check.stats.skipped).toBe(1)
    expect(check.stats.errors).toBe(0)
  })

  it('surfaces a query failure as an error, never as a crash', async () => {
    const { check } = setup({ ok: false })
    const result = await check.compare({ x: 1, y: 2 })
    expect(result).toEqual({ ok: false, reason: 'database unavailable' })
    expect(check.stats.errors).toBe(1)
  })

  it('restricts the database query to live sessions', async () => {
    const { registry, check, positions } = setup({
      players: [{ socketId: 'a', name: 'Ada', x: 1000, y: 1000 }],
      neighbours: [],
    })
    await check.compare({ x: 1000, y: 1000, excludeSessionId: registry.get('a').id })

    const query = positions.calls[0]
    expect(query.activeSessionIds).toBeInstanceOf(Set)
    expect([...query.activeSessionIds]).toEqual([registry.get('a').id])
    expect(query.radius).toBe(100)
    expect(query.maxAgeMs).toBeGreaterThan(0)
  })

  it('uses the live registry membership as the authority, so a disconnect is not a difference', async () => {
    const { registry, check, positions } = setup({
      players: [{ socketId: 'a', name: 'Ada', x: 1000, y: 1000 }],
      neighbours: [neighbour('someone-who-left')],
    })
    // The repository filters by activeSessionIds, so a session missing from the live
    // set can never be returned — the double mimics that by returning nothing when
    // the requested live set excludes the row.
    positions.findNearby = async (query) => ({
      ok: true,
      neighbours: query.activeSessionIds.has('someone-who-left') ? [neighbour('someone-who-left')] : [],
      query: {},
    })

    // Excluding Ada, as the real caller always does for the probed player.
    const result = await check.compare({ x: 1000, y: 1000, excludeSessionId: registry.get('a').id })
    expect(result.differences).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('runOnce picks a connected player and skips when nobody is connected', async () => {
    const { check } = setup({ players: [] })
    expect(await check.runOnce()).toEqual({ ok: false, reason: 'nobody connected' })

    const { check: populated, positions } = setup({
      players: [
        { socketId: 'a', name: 'Ada', x: 1000, y: 1000 },
        { socketId: 'b', name: 'Grace', x: 1010, y: 1000 },
      ],
      neighbours: [],
    })
    await populated.runOnce()
    expect(positions.calls).toHaveLength(1)
    expect(populated.stats.runs).toBe(1)
    expect(populated.lastComparison).toMatchObject({ radius: 100 })
  })

  it('describe() exposes counters and the last comparison', async () => {
    const { check } = setup({ players: [{ socketId: 'a', name: 'Ada', x: 5, y: 5 }], neighbours: [] })
    await check.runOnce()
    expect(check.describe()).toMatchObject({ intervalMs: 30_000, runs: 1, agreements: 1 })
    expect(check.describe().lastComparison.point).toEqual({ x: 5, y: 5 })
  })
})
