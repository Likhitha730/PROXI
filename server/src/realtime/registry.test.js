// Unit tests for the server-side player registry.

import { describe, expect, it } from 'vitest'
import { createPlayerRegistry } from './registry.js'
import { SPAWN_POINTS } from '../../../shared/protocol.js'

let counter = 0
const makeRegistry = (options = {}) =>
  createPlayerRegistry({ idFactory: () => `player-${++counter}`, now: () => 1_700_000_000_000, ...options })

describe('player registry', () => {
  it('mints a server-generated id and a valid spawn position', () => {
    const registry = makeRegistry()
    const { ok, player } = registry.add({ socketId: 'socket-a', name: 'Ada' })

    expect(ok).toBe(true)
    expect(player.id).toBe('player-1')
    expect(player.name).toBe('Ada')
    expect(player.joinedAt).toBe(1_700_000_000_000)
    expect(player.moving).toBe(false)
    // spawn positions always come from the shared list
    expect(SPAWN_POINTS.some((point) => point.x === player.x && point.y === player.y)).toBe(true)
  })

  it('never registers the same socket twice', () => {
    const registry = makeRegistry()
    registry.add({ socketId: 'socket-a', name: 'Ada' })
    const second = registry.add({ socketId: 'socket-a', name: 'Grace' })

    expect(second).toEqual({ ok: false, reason: 'already_registered' })
    expect(registry.size).toBe(1)
    expect(registry.get('socket-a').name).toBe('Ada')
  })

  it('treats a rename as an update, keeping identity and join time', () => {
    const registry = makeRegistry()
    const { player } = registry.add({ socketId: 'socket-a', name: 'Ada' })
    const renamed = registry.rename('socket-a', 'Ada Lovelace')

    expect(renamed.id).toBe(player.id)
    expect(renamed.joinedAt).toBe(player.joinedAt)
    expect(renamed.name).toBe('Ada Lovelace')
    expect(registry.rename('missing-socket', 'Nobody')).toBeNull()
  })

  it('spreads arrivals across spawn points so nobody spawns on top of another player', () => {
    const registry = makeRegistry()
    const a = registry.add({ socketId: 's1', name: 'One' }).player
    const b = registry.add({ socketId: 's2', name: 'Two' }).player
    const c = registry.add({ socketId: 's3', name: 'Three' }).player

    const positions = [a, b, c].map((player) => `${player.x},${player.y}`)
    expect(new Set(positions).size).toBe(3)
    for (const player of [a, b, c]) {
      expect(SPAWN_POINTS.some((point) => point.x === player.x && point.y === player.y)).toBe(true)
    }
  })

  it('only changes position through move(), and records the anti-teleport baseline', () => {
    const registry = makeRegistry()
    registry.add({ socketId: 'socket-a', name: 'Ada' })

    expect(registry.lastPosition('socket-a')).toEqual({ x: 1280, y: 1500, at: 1_700_000_000_000 })

    const moved = registry.move('socket-a', { x: 1200, y: 1400, dir: 1.2, moving: true, at: 1_700_000_000_100 })
    expect(moved).toMatchObject({ x: 1200, y: 1400, dir: 1.2, moving: true })
    expect(registry.lastPosition('socket-a')).toEqual({ x: 1200, y: 1400, at: 1_700_000_000_100 })

    expect(registry.move('unknown-socket', { x: 0, y: 0 })).toBeNull()
  })

  it('keeps the previous facing when a move omits dir', () => {
    const registry = makeRegistry()
    registry.add({ socketId: 'socket-a', name: 'Ada' })
    registry.move('socket-a', { x: 1280, y: 1490, dir: 0.5, moving: true })
    const after = registry.move('socket-a', { x: 1280, y: 1480, dir: null, moving: true })
    expect(after.dir).toBe(0.5)
  })

  it('lists players and removes transient state on disconnect', () => {
    const registry = makeRegistry()
    const first = registry.add({ socketId: 's1', name: 'One' }).player
    const second = registry.add({ socketId: 's2', name: 'Two' }).player

    expect(registry.list().map((player) => player.id)).toEqual([first.id, second.id])
    expect(registry.getById(second.id).name).toBe('Two')

    const removed = registry.remove('s1')
    expect(removed.id).toBe(first.id)
    expect(registry.size).toBe(1)
    expect(registry.get('s1')).toBeNull()
    expect(registry.lastPosition('s1')).toBeNull()
    expect(registry.remove('s1')).toBeNull()
  })

  it('freezes records so nothing can be mutated by reference', () => {
    const registry = makeRegistry()
    const { player } = registry.add({ socketId: 'socket-a', name: 'Ada' })
    expect(Object.isFrozen(player)).toBe(true)
    expect(() => {
      player.x = 0
    }).toThrow()
  })
})
