// Proximity engine tests: radius semantics, boundary cases, liveness, dedupe and
// throttling. The engine works from the registry (live connections only).

import { beforeEach, describe, expect, it } from 'vitest'
import { createProximityEngine } from './proximity.js'
import { createPlayerRegistry } from './registry.js'
import { LIMITS } from '../../../shared/protocol.js'

// Deterministic ids so assertions can name players.
let idCounter = 0
const idFactory = () => `player-${++idCounter}`

let registry
let clock
let published

function createEngine(options = {}) {
  published = []
  const engine = createProximityEngine({
    registry,
    now: () => clock,
    onUpdate: (socketId, result) => published.push({ socketId, result }),
    ...options,
  })
  return engine
}

/** Place a player at an exact position (bypassing movement validation). */
function place(socketId, name, x, y) {
  if (!registry.get(socketId)) registry.add({ socketId, name })
  registry.move(socketId, { x, y, moving: false })
  return registry.get(socketId)
}

beforeEach(() => {
  idCounter = 0
  clock = 1_000_000
  registry = createPlayerRegistry({ idFactory, now: () => clock })
})

describe('radius semantics', () => {
  it('uses the documented default of 100 world units', () => {
    const engine = createEngine()
    expect(engine.radius).toBe(100)
    expect(LIMITS.PROXIMITY_RADIUS).toBe(100)
  })

  it('finds a player inside the radius with the exact distance', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1040) // 3-4-5 triangle → exactly 50 u
    const engine = createEngine()

    const neighbours = engine.findNeighboursFor(1000, 1000, { excludeId: registry.get('a').id })
    expect(neighbours).toHaveLength(1)
    expect(neighbours[0]).toMatchObject({ name: 'Grace', x: 1030, y: 1040 })
    expect(neighbours[0].distance).toBeCloseTo(50, 6)
  })

  it('excludes a player outside the radius', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Far', 1000, 1101) // 101 u
    const engine = createEngine()
    expect(engine.findNeighboursFor(1000, 1000, { excludeId: registry.get('a').id })).toEqual([])
  })

  it('includes a player exactly on the boundary (inclusive)', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Edge', 1100, 1000) // exactly 100 u
    const engine = createEngine()

    const neighbours = engine.findNeighboursFor(1000, 1000, { excludeId: registry.get('a').id })
    expect(neighbours.map((entry) => entry.name)).toEqual(['Edge'])
    expect(neighbours[0].distance).toBe(100)
  })

  it('finds neighbours in adjacent and diagonal grid cells, anywhere in the 3x3 block', () => {
    place('a', 'Ada', 100, 100) // cell (1,1)
    place('b', 'West', 40, 100) // cell (0,1) — 60 u
    place('c', 'SouthWest', 60, 60) // cell (0,0) — 56.6 u, the diagonal cell
    place('d', 'FarEdge', 100, 200) // cell (1,2) — exactly 100 u, bottom of the block
    place('e', 'Outside', 100, 300) // two cells away: 200 u, correctly out of range
    const engine = createEngine()

    const neighbours = engine.findNeighboursFor(100, 100, { excludeId: registry.get('a').id })
    // nearest first; the exactly-100 u neighbour in the cell below is included
    expect(neighbours.map((entry) => entry.name)).toEqual(['SouthWest', 'West', 'FarEdge'])
    expect(neighbours.map((entry) => Math.round(entry.distance))).toEqual([57, 60, 100])
  })

  it('handles a negative-coordinate cell correctly (grid arithmetic is not clamped)', () => {
    place('a', 'Ada', -5, -5)
    place('b', 'Close', -40, -40)
    const engine = createEngine()
    const neighbours = engine.findNeighboursFor(-5, -5, { excludeId: registry.get('a').id })
    expect(neighbours.map((entry) => entry.name)).toEqual(['Close'])
  })
})

describe('self-exclusion and duplicates', () => {
  it('never includes the listener as their own neighbour', () => {
    const ada = place('a', 'Ada', 1000, 1000)
    const engine = createEngine()

    const result = engine.update('a', { force: true, publish: false }).result
    expect(result.id).toBe(ada.id)
    expect(result.neighbours.some((neighbour) => neighbour.id === ada.id)).toBe(false)
    expect(result.neighbours).toHaveLength(0)
    expect(engine.findNeighboursFor(1000, 1000, { excludeId: ada.id }).some((entry) => entry.id === ada.id)).toBe(false)
  })

  it('returns each neighbour once, even with players in the same cell', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'One', 1005, 1005)
    place('c', 'Two', 1010, 1010)
    place('d', 'Three', 1015, 1015)
    const engine = createEngine()

    const neighbours = engine.findNeighboursFor(1000, 1000, { excludeId: registry.get('a').id })
    const ids = neighbours.map((entry) => entry.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('sorts neighbours nearest first', () => {
    place('a', 'Ada', 0, 0)
    place('b', 'Far', 0, 80)
    place('c', 'Near', 0, 20)
    place('d', 'Middle', 0, 50)
    const engine = createEngine()

    const neighbours = engine.findNeighboursFor(0, 0, { excludeId: registry.get('a').id })
    expect(neighbours.map((entry) => entry.name)).toEqual(['Near', 'Middle', 'Far'])
  })

  it('caps the neighbour list and reports saturation', () => {
    place('a', 'Ada', 0, 0)
    for (let index = 0; index < 30; index += 1) place(`p${index}`, `P${index}`, 1 + index * 0.5, 0)
    const engine = createEngine({ })

    const result = engine.update('a', { force: true, publish: false }).result
    expect(result.neighbours.length).toBe(LIMITS.PROXIMITY_MAX_NEIGHBOURS)
    expect(engine.update('a', { force: true, publish: false }).result.neighbours.length).toBeLessThanOrEqual(16)
  })
})

describe('liveness — disconnected sessions disappear immediately', () => {
  it('drops a player from results the moment their session ends', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()

    engine.track('a')
    expect(engine.resultFor('a').neighbours.map((entry) => entry.name)).toEqual(['Grace'])

    registry.remove('b') // as the disconnect handler does
    const after = engine.update('a', { force: true, publish: false }).result
    expect(after.neighbours).toEqual([])
  })

  it('forgets a socket that disconnects, and updateAll skips it', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()
    engine.track('a')
    engine.track('b')

    engine.forget('b')
    registry.remove('b')

    const results = engine.updateAll()
    expect(results.map((entry) => entry.socketId)).toEqual(['a'])
    expect(engine.describe().tracked).toBe(1)
  })

  it('does not create state for a socket that is not registered', () => {
    const engine = createEngine()
    const { result, reason } = engine.update('ghost')
    expect(result).toBeNull()
    expect(reason).toBe('not_registered')
    expect(engine.describe().tracked).toBe(0)
  })
})

describe('throttling', () => {
  it('publishes on the first forced computation and not again while stationary', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()

    engine.update('a', { force: true })
    expect(published).toHaveLength(1)

    const second = engine.update('a')
    expect(second.broadcast).toBe(false)
    expect(second.reason).toBe('interval')
    expect(published).toHaveLength(1)
    expect(engine.stats.throttled).toBe(1)
  })

  it('respects the 4 Hz interval even while moving', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()
    engine.update('a', { force: true })
    expect(published).toHaveLength(1)

    // Move 20 u every 100 ms (inside the interval) for one second.
    for (let step = 0; step < 10; step += 1) {
      clock += 100
      registry.move('a', { x: 1020 + step * 5, y: 1000, moving: true })
      engine.update('a')
    }

    // 1 forced + at most ~4 interval-driven publications in 1 s.
    expect(published.length).toBeLessThanOrEqual(5)
    expect(engine.stats.broadcasts).toBeLessThanOrEqual(5)
  })

  it('does not recompute while the player has moved less than the minimum distance', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()
    engine.update('a', { force: true })
    const computations = engine.stats.computations

    for (let step = 0; step < 5; step += 1) {
      clock += 300 // well past the interval
      registry.move('a', { x: 1000 + step * 1.2, y: 1000, moving: true }) // < 8 u total
      engine.update('a')
    }

    expect(engine.stats.computations).toBe(computations)
    expect(engine.stats.throttled).toBe(5)
  })

  it('always recomputes and publishes when forced (join/leave never wait)', () => {
    place('a', 'Ada', 1000, 1000)
    const engine = createEngine()
    engine.update('a', { force: true })
    clock += 10 // inside the interval

    place('b', 'Grace', 1010, 1000)
    engine.update('a', { force: true })

    expect(published).toHaveLength(2)
    expect(published[1].result.neighbours.map((entry) => entry.name)).toEqual(['Grace'])
  })

  it('publishes a distance refresh when the listener really moves', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1090, 1000) // inside the radius but far from the edge
    const engine = createEngine()
    engine.update('a', { force: true })
    const before = published.length

    // Moving 12 u (>= PROXIMITY_MIN_MOVEMENT) refreshes the distances a client draws,
    // even though nobody entered or left the radius.
    clock += 500
    registry.move('a', { x: 1012, y: 1000, moving: true })
    const update = engine.update('a')

    expect(update.broadcast).toBe(true)
    expect(published.length).toBe(before + 1)
    expect(published.at(-1).result.neighbours[0].distance).toBeCloseTo(78, 5) // 1090 - 1012
  })
})

describe('hysteresis', () => {
  it('keeps a neighbour that drifts just past the radius, and drops them further out', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1085, 1000) // 85 u: nearby
    const engine = createEngine()
    engine.track('a')
    expect(engine.resultFor('a').neighbours).toHaveLength(1)

    // 105 u away: inside radius + hysteresis (112), so they stay nearby.
    clock += 500
    registry.move('b', { x: 1105, y: 1000, moving: true })
    expect(engine.update('a', { force: true, publish: false }).result.neighbours).toHaveLength(1)

    // 120 u away: outside radius + hysteresis → gone.
    clock += 500
    registry.move('b', { x: 1120, y: 1000, moving: true })
    expect(engine.update('a', { force: true, publish: false }).result.neighbours).toHaveLength(0)
  })

  it('does not apply hysteresis to a player who was never nearby', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1105, 1000) // 105 u: never inside 100 u
    const engine = createEngine()
    engine.track('a')
    expect(engine.resultFor('a').neighbours).toEqual([])
  })
})

describe('updateAffected — walking up to somebody who is standing still', () => {
  it('tells a stationary player when someone walks into their radius', () => {
    place('a', 'Ada', 1000, 1000) // standing still, never moves again
    place('b', 'Grace', 1200, 1000) // 200 u away: they cannot hear each other
    const engine = createEngine()
    engine.track('a')
    engine.track('b')

    expect(engine.resultFor('a').neighbours).toEqual([])
    expect(engine.resultFor('b').neighbours).toEqual([])

    // Grace walks to within 40 u of Ada — Ada never sends a single packet.
    place('b', 'Grace', 1040, 1000)
    engine.updateAffected('b')

    const publishedToAda = published.filter((entry) => entry.socketId === 'a').at(-1)
    expect(publishedToAda.result.neighbours.map((entry) => entry.name)).toEqual(['Grace'])
    expect(publishedToAda.result.neighbours[0].distance).toBe(40)
  })

  it('tells a stationary player when someone walks back out of range', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()
    engine.track('a')
    engine.track('b')
    expect(engine.resultFor('a').neighbours).toHaveLength(1)

    place('b', 'Grace', 1400, 1000)
    engine.updateAffected('b')

    expect(published.filter((entry) => entry.socketId === 'a').at(-1).result.neighbours).toEqual([])
  })

  it('recomputes the mover as well', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1050, 1000)
    const engine = createEngine()
    engine.track('a')
    engine.track('b')

    // Far past an interval-only window: this is the first computation for both.
    const outcome = engine.updateAffected('b')
    expect(outcome.mover.result.neighbours.map((entry) => entry.name)).toEqual(['Ada'])
    expect(outcome.affected.length).toBeGreaterThanOrEqual(1)
  })

  it('does not publish distance churn to a stationary player faster than the interval', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1050, 1000)
    const engine = createEngine()
    engine.track('a')
    engine.track('b')
    const publishedToAda = () => published.filter((entry) => entry.socketId === 'a').length

    // Baseline: the join path forces a publication, so Ada knows about Grace.
    engine.update('a', { force: true })
    expect(publishedToAda()).toBe(1)

    // Grace shuffles about nearby: Ada's neighbour set never changes.
    for (let step = 1; step <= 3; step += 1) {
      place('b', 'Grace', 1050 + step, 1000)
      engine.updateAffected('b')
    }

    expect(publishedToAda()).toBe(1) // still inside the 250 ms interval
    clock += 300
    place('b', 'Grace', 1060, 1000)
    engine.updateAffected('b')
    expect(publishedToAda()).toBe(2)
  })

  it('is a no-op for an unregistered socket', () => {
    const engine = createEngine()
    const outcome = engine.updateAffected('ghost')
    expect(outcome.result).toBeNull()
    expect(outcome.reason).toBe('not_registered')
  })
})

describe('result shape and equality', () => {
  it('produces the documented internal result: positions, distances, radius', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1040)
    const engine = createEngine({ })
    const result = engine.update('a', { force: true, publish: false }).result

    expect(result).toMatchObject({ id: registry.get('a').id, radius: 100 })
    expect(result.at).toBe(clock)
    expect(result.neighbours[0]).toEqual({
      id: registry.get('b').id,
      name: 'Grace',
      x: 1030,
      y: 1040,
      distance: 50,
      nearby: true,
    })
  })

  it('recognises an unchanged neighbourhood within a distance bucket', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1050, 1000)
    const engine = createEngine()
    const first = engine.update('a', { force: true, publish: false }).result

    clock += 400
    registry.move('b', { x: 1050.4, y: 1000, moving: false })
    const second = engine.update('a', { force: true, publish: false }).result

    expect(engine.isSameAsPrevious('a', first)).toBe(true)
    expect(engine.isSameAsPrevious('a', second)).toBe(true)
  })

  it('reports a changed neighbourhood as different', () => {
    place('a', 'Ada', 1000, 1000)
    const engine = createEngine()
    const first = engine.update('a', { force: true, publish: false }).result

    place('b', 'Grace', 1000, 1050)
    const second = engine.update('a', { force: true, publish: false }).result

    expect(engine.isSameAsPrevious('a', first)).toBe(false)
    expect(second.neighbours).toHaveLength(1)
  })
})

describe('invalid and hostile input', () => {
  it('handles a NaN position without producing NaN distances', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()

    // A NaN target must simply match nothing — never poison the grid.
    const neighbours = engine.findNeighboursFor(Number.NaN, 1000, { excludeId: registry.get('a').id })
    expect(neighbours).toEqual([])
  })

  it('ignores extreme coordinates instead of overflowing', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1e9, 1e9)
    const engine = createEngine()
    expect(engine.findNeighboursFor(1000, 1000, { excludeId: registry.get('a').id })).toEqual([])
  })
})

describe('diagnostics', () => {
  it('describes tracking state and counters', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()
    engine.track('a')
    engine.track('b')
    engine.update('a', { force: true })

    expect(engine.describe()).toMatchObject({ tracked: 2, radius: 100 })
    expect(engine.describe().stats.computations).toBeGreaterThan(0)

    engine.reset()
    expect(engine.describe().tracked).toBe(0)
  })

  it('track() registers silently, and a forced update publishes the socket id', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1030, 1000)
    const engine = createEngine()

    // Registering must not emit: a joining player gets one result, from the
    // membership broadcast that follows.
    expect(engine.track('a')).toMatchObject({ id: registry.get('a').id })
    expect(published).toHaveLength(0)

    engine.update('a', { force: true })
    expect(published.at(-1)).toMatchObject({ socketId: 'a' })
    expect(published.at(-1).result.neighbours.map((entry) => entry.name)).toEqual(['Grace'])
  })

  it('recovers when the registry loses a player between updates', () => {
    place('a', 'Ada', 1000, 1000)
    const engine = createEngine()
    engine.track('a')

    registry.remove('a')
    expect(() => engine.updateAll()).not.toThrow()
    expect(engine.describe().tracked).toBe(0)
  })
})
