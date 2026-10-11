// Unit tests for the presence model — the bridge between the socket and both the
// canvas engine (hot path) and the React HUD (coarse, structural changes only).

import { describe, expect, it, vi } from 'vitest'
import { createPresence } from './presence.js'
import { LIMITS } from '../../../shared/protocol.js'

function createClock(start = 0) {
  let value = start
  const clock = () => value
  clock.advance = (ms) => {
    value += ms
    return value
  }
  return clock
}

const record = (overrides = {}) => ({
  id: 'player-a',
  name: 'Ada',
  x: 1280,
  y: 1500,
  dir: Math.PI / 2,
  moving: false,
  joinedAt: 1_700_000_000_000,
  ...overrides,
})

function joinedPresence() {
  const clock = createClock(1000)
  const presence = createPresence({ now: clock })
  presence.applySnapshot({ self: record({ id: 'self-1', name: 'Me' }), players: [record()], room: { id: 'lobby', maxPlayers: 24 } })
  return { presence, clock }
}

describe('roster and session state', () => {
  it('applies a snapshot: self, room and the existing players', () => {
    const { presence } = joinedPresence()
    const snapshot = presence.getSnapshot()

    expect(snapshot.ready).toBe(true)
    expect(snapshot.self).toMatchObject({ id: 'self-1', name: 'Me' })
    expect(snapshot.room.id).toBe('lobby')
    expect(snapshot.players).toEqual([{ id: 'player-a', name: 'Ada' }])
    expect(snapshot.count).toBe(2) // self + Ada
    expect(presence.peerCount).toBe(1)
  })

  it('counts joins and leaves', () => {
    const { presence } = joinedPresence()
    presence.applyJoined({ player: record({ id: 'player-b', name: 'Grace' }) })
    expect(presence.getSnapshot().count).toBe(3)

    presence.applyLeft({ id: 'player-b' })
    expect(presence.getSnapshot().count).toBe(2)
    expect(presence.getSnapshot().players.map((player) => player.name)).toEqual(['Ada'])

    // leaving twice, or leaving an unknown id, is harmless
    expect(presence.applyLeft({ id: 'player-b' }).count).toBe(2)
    expect(presence.applyLeft({}).count).toBe(2)
  })

  it('treats player:joined as an upsert so renames work in both directions', () => {
    const { presence } = joinedPresence()
    presence.applyJoined({ player: record({ name: 'Ada Lovelace' }) })
    expect(presence.getSnapshot().players).toEqual([{ id: 'player-a', name: 'Ada Lovelace' }])
    expect(presence.peerCount).toBe(1)

    // our own rename updates `self`, not the peer list
    presence.applyJoined({ player: record({ id: 'self-1', name: 'Me, renamed' }) })
    expect(presence.getSnapshot().self.name).toBe('Me, renamed')
    expect(presence.peerCount).toBe(1)
  })

  it('ignores malformed events instead of throwing', () => {
    const { presence } = joinedPresence()
    expect(() => {
      presence.applySnapshot({})
      presence.applyJoined({})
      presence.applyLeft(null)
      presence.applyMove({})
      presence.applyError('nope')
    }).not.toThrow()
    expect(presence.getSnapshot().ready).toBe(false) // snapshot without self
  })
})

describe('movement is kept out of React state', () => {
  it('buffers moves without notifying subscribers', () => {
    const { presence, clock } = joinedPresence()
    const listener = vi.fn()
    presence.subscribe(listener)

    for (let i = 0; i < 30; i += 1) {
      clock.advance(66)
      presence.applyMove({ id: 'player-a', x: 1280 - i, y: 1400, dir: 3.1, moving: true })
    }

    expect(listener).not.toHaveBeenCalled() // 30 movement events, zero re-renders
    expect(presence.moveCount).toBe(30) // telemetry is kept off the React snapshot
    expect(presence.getSnapshot().acceptedMoves).toBe(0)

    // structural changes still notify
    presence.applyJoined({ player: record({ id: 'player-c', name: 'Alan' }) })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores movement for players it does not know', () => {
    const { presence } = joinedPresence()
    expect(presence.applyMove({ id: 'stranger', x: 1, y: 1, moving: true })).toBe(false)
    expect(presence.moveCount).toBe(0)
    expect(presence.getSnapshot().acceptedMoves).toBe(0)
  })
})

describe('interpolation hand-off to the engine', () => {
  it('returns interpolated, moving positions on the hot path', () => {
    const { presence, clock } = joinedPresence()
    const startX = 1280

    // A peer walking west at ~205 u/s, reporting at 15 Hz.
    for (let i = 1; i <= 6; i += 1) {
      presence.applyMove({ id: 'player-a', x: startX - i * 13.7, y: 1500, dir: Math.PI, moving: true })
      clock.advance(66.6)
    }

    const first = presence.collectPeers(clock())[0]
    const firstX = first.x
    clock.advance(16)
    const second = presence.collectPeers(clock())[0]

    expect(first.id).toBe('player-a')
    expect(first.isLocal).toBe(false)
    expect(second.x).toBeLessThan(firstX) // still walking west, smoothly
    expect(second.moving).toBe(true)
  })

  it('reuses peer objects and the returned array every frame', () => {
    const { presence, clock } = joinedPresence()
    presence.applyMove({ id: 'player-a', x: 1200, y: 1500, dir: 0, moving: true })
    clock.advance(300)

    const a = presence.collectPeers(clock())
    const b = presence.collectPeers(clock())
    expect(a).toBe(b)
    expect(a[0]).toBe(b[0])
  })

  it('gives every peer a deterministic, varied appearance', () => {
    const first = createPresence({ now: () => 0 })
    first.applyJoined({ player: record({ id: 'player-x' }) })
    const second = createPresence({ now: () => 0 })
    second.applyJoined({ player: record({ id: 'player-x' }) })
    const other = createPresence({ now: () => 0 })
    other.applyJoined({ player: record({ id: 'player-y' }) })

    const appearanceOf = (presence) => presence.collectPeers(0)[0].appearance
    expect(appearanceOf(first)).toEqual(appearanceOf(second)) // stable per id
    expect(appearanceOf(first)).not.toEqual(appearanceOf(other)) // distinct looks
    expect(appearanceOf(first).accessory).toBeTruthy()
  })
})

describe('server authority', () => {
  it('exposes a rejected position as a correction the engine can drain', () => {
    const { presence } = joinedPresence()
    expect(presence.takeCorrection()).toBeNull()

    presence.applyError({ code: 'invalid_position', message: 'position rejected', data: { x: 1200, y: 1300 } })
    expect(presence.takeCorrection()).toEqual({ x: 1200, y: 1300 })
    expect(presence.takeCorrection()).toBeNull() // drained once
    expect(presence.getSnapshot().corrections).toBe(1)
  })

  it('surfaces other server errors in the HUD and can clear them', () => {
    const { presence } = joinedPresence()
    presence.applyError({ code: 'rate_limited', message: 'Movement updates are limited to 15 per second.' })
    expect(presence.getSnapshot().lastError).toMatchObject({ code: 'rate_limited' })
    expect(presence.takeCorrection()).toBeNull()

    presence.clearError()
    expect(presence.getSnapshot().lastError).toBeNull()
  })
})

describe('teardown', () => {
  it('reset drops every player and returns to the initial snapshot', () => {
    const { presence } = joinedPresence()
    presence.reset()

    expect(presence.peerCount).toBe(0)
    expect(presence.collectPeers(0)).toEqual([])
    expect(presence.getSnapshot()).toMatchObject({ ready: false, self: null, count: 0, players: [] })
  })

  it('keeps the snapshot frozen on every event', () => {
    const { presence } = joinedPresence()
    expect(Object.isFrozen(presence.getSnapshot())).toBe(true)
    presence.applyJoined({ player: record({ id: 'player-d' }) })
    expect(Object.isFrozen(presence.getSnapshot())).toBe(true)
    expect(Object.isFrozen(presence.getSnapshot().players)).toBe(true)
  })

  it('uses the shared interpolation window from the protocol module', () => {
    const presence = createPresence({ now: () => 0 })
    presence.applyJoined({ player: record({ id: 'player-z' }) })
    const peer = presence.collectPeers(0)[0]
    expect(peer.motion.delayMs).toBe(LIMITS.INTERPOLATION_DELAY_MS)
  })
})

describe('proximity results (proximity:update)', () => {
  const proximityPayload = (neighbours, overrides = {}) => ({
    id: 'self-1',
    radius: LIMITS.PROXIMITY_RADIUS,
    at: 1_700_000_000_123,
    neighbours,
    ...overrides,
  })

  const neighbour = (overrides = {}) => ({ id: 'player-a', name: 'Ada', x: 1300, y: 1500, distance: 20, nearby: true, ...overrides })

  it('starts with the documented default radius and no neighbours', () => {
    const { presence } = joinedPresence()
    expect(presence.getProximity()).toMatchObject({ radius: LIMITS.PROXIMITY_RADIUS, count: 0 })
    expect(presence.getProximity().nearby).toEqual([])
    expect(presence.getSnapshot().proximity.count).toBe(0)
  })

  it('records positions and distances for nearby users', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([neighbour()]))

    const view = presence.getProximity()
    expect(view.radius).toBe(100)
    expect(view.at).toBe(1_700_000_000_123)
    expect(view.nearby[0]).toEqual({ id: 'player-a', name: 'Ada', distance: 20, x: 1300, y: 1500 })
    expect(presence.getSnapshot().proximity.nearby[0].distance).toBe(20)
  })

  it('flags the peer objects the canvas ring reads, and clears the flag when they leave range', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([neighbour()]))
    expect(presence.getPeers()[0]).toMatchObject({ id: 'player-a', nearby: true, distance: 20 })

    presence.applyProximity(proximityPayload([]))
    expect(presence.getPeers()[0]).toMatchObject({ id: 'player-a', nearby: false, distance: null })
  })

  it('never lists us as our own neighbour, even if the server sent it', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([neighbour({ id: 'self-1', name: 'Me', distance: 0 })]))
    expect(presence.getProximity().nearby).toEqual([])
  })

  it('deduplicates entries and orders them nearest first', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(
      proximityPayload([
        neighbour({ id: 'player-c', name: 'Carol', distance: 60 }),
        neighbour({ id: 'player-a', name: 'Ada', distance: 20 }),
        neighbour({ id: 'player-c', name: 'Carol', distance: 55 }),
      ]),
    )

    const nearby = presence.getProximity().nearby
    expect(nearby.map((entry) => entry.id)).toEqual(['player-a', 'player-c'])
    expect(nearby.map((entry) => entry.distance)).toEqual([20, 60])
  })

  it('ignores malformed payloads instead of throwing', () => {
    const { presence } = joinedPresence()
    for (const payload of [null, undefined, {}, { neighbours: 'nope' }, { neighbours: [null, {}] }]) {
      expect(() => presence.applyProximity(payload)).not.toThrow()
    }
    expect(presence.getProximity().nearby).toEqual([])
  })

  it('adopts the radius the server reports', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([], { radius: 175 }))
    expect(presence.getProximity().radius).toBe(175)
    expect(presence.proximityRadius).toBe(175)
    expect(presence.getSnapshot().proximity.radius).toBe(175)
  })

  it('notifies React the moment the nearby set changes', () => {
    const { presence } = joinedPresence()
    const listener = vi.fn()
    presence.subscribe(listener)

    presence.applyProximity(proximityPayload([neighbour()]))
    expect(listener).toHaveBeenCalledTimes(1)

    presence.applyProximity(proximityPayload([neighbour({ id: 'player-b', name: 'Grace', distance: 40 })]))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('rate-limits distance-only refreshes so a walking neighbour cannot re-render the HUD 4x/second', () => {
    const clock = createClock(1000)
    const presence = createPresence({ now: clock })
    presence.applySnapshot({ self: record({ id: 'self-1', name: 'Me' }), players: [record()], room: { id: 'lobby' } })

    const listener = vi.fn()
    presence.subscribe(listener)

    presence.applyProximity(proximityPayload([neighbour({ distance: 20 })]))
    expect(listener).toHaveBeenCalledTimes(1)

    // 4 Hz traffic (a frame every 250 ms) with only the distance moving: React hears
    // about it once per PROXIMITY_UI_INTERVAL_MS (500 ms), not four times a second.
    for (const [distance, expected] of [[21, 1], [22, 2], [23, 2]]) {
      clock.advance(250)
      presence.applyProximity(proximityPayload([neighbour({ distance })]))
      expect(listener).toHaveBeenCalledTimes(expected)
    }

    // The model itself is always current — only the HUD notification is rate-limited.
    expect(presence.getProximity().nearby[0].distance).toBe(23)
    expect(presence.getPeers()[0].distance).toBe(23)
    expect(presence.getSnapshot().proximity.nearby[0].distance).toBe(22)
  })

  it('drops proximity state when a session resets', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([neighbour()]))
    presence.reset()

    expect(presence.getProximity()).toMatchObject({ radius: LIMITS.PROXIMITY_RADIUS, count: 0 })
    expect(presence.getSnapshot().proximity.count).toBe(0)
  })

  it('keeps the snapshot frozen, proximity included', () => {
    const { presence } = joinedPresence()
    presence.applyProximity(proximityPayload([neighbour()]))

    const snapshot = presence.getSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.proximity)).toBe(true)
    expect(Object.isFrozen(snapshot.proximity.nearby)).toBe(true)
    expect(Object.isFrozen(snapshot.proximity.nearby[0])).toBe(true)
  })
})
