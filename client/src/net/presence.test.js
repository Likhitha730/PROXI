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
