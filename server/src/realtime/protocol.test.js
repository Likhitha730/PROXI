// Protocol tests — the wire contract shared by client and server.
//
// Part 1 pins the event set (so a rename cannot silently break the other side).
// Part 2 tests the validators the server relies on for authority.

import { describe, expect, it } from 'vitest'
import {
  ALL_EVENTS,
  CLIENT_TO_SERVER_EVENTS,
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  SERVER_TO_CLIENT_EVENTS,
  SIGNALING_EVENTS,
  createMoveUpdate,
  createPlayerRecord,
  createSnapshot,
  isInsideWorld,
  normaliseName,
  pickSpawnPoint,
  roundCoord,
  validateMove,
} from '../../../shared/protocol.js'
import { SPAWNS, WALKABLE_BOUNDS, WORLD } from '../../../client/src/world/worldData.js'

describe('protocol shape', () => {
  it('exposes exactly the documented event set', () => {
    expect(ALL_EVENTS).toHaveLength(15)
    expect(ALL_EVENTS).toEqual([
      'player:join',
      'player:move',
      'audio:ready',
      'signal:offer',
      'signal:answer',
      'signal:ice',
      'signal:close',
      'players:snapshot',
      'player:joined',
      'player:moved',
      'player:left',
      'proximity:update',
      'audio:peer',
      'audio:status',
      'server:error',
    ])
    expect(new Set(ALL_EVENTS).size).toBe(ALL_EVENTS.length)
  })

  it('namespaces every event by the entity it concerns', () => {
    for (const name of ALL_EVENTS) {
      expect(name).toMatch(/^(player|players|proximity|audio|signal|server):[a-z]+$/)
    }
    expect(CLIENT_TO_SERVER_EVENTS).toHaveLength(7)
    expect(SERVER_TO_CLIENT_EVENTS).toHaveLength(12)
    // The four signalling events are the only ones that travel both ways, and they
    // appear exactly once in the combined list.
    expect(SIGNALING_EVENTS).toHaveLength(4)
    for (const event of SIGNALING_EVENTS) {
      expect(CLIENT_TO_SERVER_EVENTS).toContain(event)
      expect(SERVER_TO_CLIENT_EVENTS).toContain(event)
      expect(ALL_EVENTS.filter((name) => name === event)).toHaveLength(1)
    }
  })

  it('agrees with the map data the renderer uses', () => {
    // The server validates coordinates without importing the renderer, so these
    // numbers must stay in lockstep with worldData.js.
    expect(LIMITS.WORLD_WIDTH).toBe(WORLD.width)
    expect(LIMITS.WORLD_HEIGHT).toBe(WORLD.height)
    expect(LIMITS.WALKABLE_X).toBe(WALKABLE_BOUNDS.x)
    expect(LIMITS.WALKABLE_Y).toBe(WALKABLE_BOUNDS.y)
    expect(LIMITS.WALKABLE_WIDTH).toBe(WALKABLE_BOUNDS.w)
    expect(LIMITS.WALKABLE_HEIGHT).toBe(WALKABLE_BOUNDS.h)
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
  })

  it('builds one consistent player record for snapshots and moves', () => {
    const record = createPlayerRecord({ id: 'p1', name: 'Ada', x: 10.123456, y: 20, dir: 1, moving: true })
    expect(record).toEqual({
      id: 'p1',
      name: 'Ada',
      x: 10.12,
      y: 20,
      dir: 1,
      moving: true,
      joinedAt: expect.any(Number),
      // Audio eligibility travels with the record, so a joiner knows who is already
      // willing to talk without a second round trip.
      audio: { enabled: false, muted: false },
    })
    expect(createPlayerRecord({ id: 'p2', name: 'G', x: 0, y: 0, audio: { enabled: true, muted: true } }).audio).toEqual({
      enabled: true,
      muted: true,
    })
    expect(roundCoord(2.999)).toBe(3)
    expect(roundCoord(10.123456)).toBe(10.12)

    const snapshot = createSnapshot({ self: record, players: [record], room: { id: 'lobby' } })
    expect(Object.keys(snapshot)).toEqual(['version', 'self', 'players', 'room', 'world', 'moveHz', 'serverTs'])
    expect(snapshot.room).toEqual({ id: 'lobby', maxPlayers: LIMITS.MAX_PLAYERS_PER_ROOM })
    expect(snapshot.moveHz).toBe(LIMITS.MOVE_UPDATES_PER_SECOND)

    expect(createMoveUpdate({ id: 'p1', x: 1, y: 2, dir: 0, moving: false, serverTs: 5 })).toEqual({
      id: 'p1',
      x: 1,
      y: 2,
      dir: 0,
      moving: false,
      serverTs: 5,
    })
  })

  it('hands out spawn points in the documented order for an empty room', () => {
    expect(pickSpawnPoint([]).id).toBe('entrance')
    expect(pickSpawnPoint([{ x: 1280, y: 1500 }]).id).toBe('meeting')
    expect(SPAWNS.map((spawn) => spawn.id)).toEqual(['entrance', 'workspace', 'meeting'])
  })
})

describe('display name validation', () => {
  it('accepts reasonable names and trims them', () => {
    expect(normaliseName('Ada')).toEqual({ ok: true, value: 'Ada' })
    expect(normaliseName('  Ada   Lovelace ')).toEqual({ ok: true, value: 'Ada Lovelace' })
    expect(normaliseName('José-Ñ 2nd')).toEqual({ ok: true, value: 'José-Ñ 2nd' })
    expect(normaliseName('a'.repeat(LIMITS.NAME_MAX_LENGTH)).ok).toBe(true)
  })

  it('rejects empty, oversized, non-string and hostile names', () => {
    for (const bad of ['', '   ', 'a'.repeat(LIMITS.NAME_MAX_LENGTH + 1), null, undefined, 42, {}, []]) {
      expect(normaliseName(bad).ok, `should reject ${JSON.stringify(bad)}`).toBe(false)
    }
    expect(normaliseName('<script>alert(1)</script>').ok).toBe(false)
    expect(normaliseName('-leading-separator').ok).toBe(false)
    expect(normaliseName('Ada\u0000').ok).toBe(false)
    expect(normaliseName('emoji 🎉 name').ok).toBe(false)
    // Whitespace (including newlines) is collapsed rather than rejected: the
    // result cannot carry control characters onto the wire.
    expect(normaliseName('line\nbreak')).toEqual({ ok: true, value: 'line break' })
  })
})

describe('position validation', () => {
  const baseline = { x: 1280, y: 1500, at: 1_000_000 }

  it('accepts a plausible walking step and rounds coordinates', () => {
    const result = validateMove(
      { x: 1285.6789, y: 1495.1234, dir: 1.5, moving: true, clientTs: 1_000_050 },
      baseline,
      { now: 1_000_050 },
    )
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ x: 1285.68, y: 1495.12, dir: 1.5, moving: true })
  })

  it('rejects malformed payloads', () => {
    for (const payload of [null, undefined, 'nope', 12, [], { x: '1280', y: 1500 }]) {
      const result = validateMove(payload, baseline, { now: 1_000_000 })
      expect(result.ok).toBe(false)
      expect(result.code).toBe(ERROR_CODES.INVALID_PAYLOAD)
    }
    expect(validateMove({ x: 1280, y: 1500, dir: Number.NaN }, baseline).code).toBe(ERROR_CODES.INVALID_PAYLOAD)
    expect(validateMove({ x: 1280, y: 1500, moving: 'yes' }, baseline).code).toBe(ERROR_CODES.INVALID_PAYLOAD)
    expect(validateMove({ x: 1280, y: 1500, clientTs: Number.POSITIVE_INFINITY }, baseline).code).toBe(
      ERROR_CODES.INVALID_PAYLOAD,
    )
  })

  it('rejects out-of-world and hostile values', () => {
    const huge = validateMove({ x: 1e12, y: 1e12 }, baseline)
    expect(huge).toMatchObject({ ok: false, code: ERROR_CODES.INVALID_POSITION })

    expect(validateMove({ x: Number.POSITIVE_INFINITY, y: 5 }, baseline).ok).toBe(false)
    expect(validateMove({ x: -1, y: 5 }, baseline).ok).toBe(false)
    expect(validateMove({ x: 5, y: WORLD.height + 1 }, baseline).ok).toBe(false)
    expect(isInsideWorld(LIMITS.WALKABLE_X, LIMITS.WALKABLE_Y)).toBe(true)
    expect(isInsideWorld(LIMITS.WALKABLE_X - 1, LIMITS.WALKABLE_Y)).toBe(false)
  })

  it('rejects teleporting beyond the anti-cheat allowance', () => {
    const teleport = validateMove({ x: 100, y: 100 }, baseline, { now: baseline.at + 66 })
    expect(teleport).toMatchObject({ ok: false, code: ERROR_CODES.INVALID_POSITION })
    expect(teleport.reason).toMatch(/limit/)

    // A smaller catch-up move is fine when the client really was away (4 s of
    // hidden tab allows roughly 205 u/s * 4 s + slack).
    const returnAfterAway = validateMove({ x: 900, y: 1200 }, baseline, { now: baseline.at + 4000 })
    expect(returnAfterAway.ok).toBe(true)
    // ...but the allowance is still bounded: a cross-map jump stays rejected.
    expect(validateMove({ x: 100, y: 100 }, baseline, { now: baseline.at + 4000 }).ok).toBe(false)
  })

  it('allows a full-speed sprint between two 15 Hz updates', () => {
    // 205 u/s * 66.6 ms ≈ 13.7 u; the allowance (plus slack) must cover it.
    const step = (LIMITS.MAX_SPEED_UNITS_PER_SECOND * 1000) / LIMITS.MOVE_UPDATES_PER_SECOND / 1000
    const result = validateMove({ x: baseline.x + step, y: baseline.y }, baseline, { now: baseline.at + 66 })
    expect(result.ok).toBe(true)
  })

  it('rejects a client timestamp from the future but tolerates small skew', () => {
    const future = validateMove({ x: 1280, y: 1500, clientTs: baseline.at + LIMITS.CLOCK_SKEW_MS + 1 }, baseline, {
      now: baseline.at,
    })
    expect(future.code).toBe(ERROR_CODES.INVALID_PAYLOAD)

    const skewed = validateMove({ x: 1280, y: 1500, clientTs: baseline.at + 500 }, baseline, { now: baseline.at })
    expect(skewed.ok).toBe(true)
  })
})
