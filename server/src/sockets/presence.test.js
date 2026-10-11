// Integration tests for the multiplayer server.
//
// Nothing is mocked: a real Socket.IO server, real Socket.IO clients, the real
// registry. These are the checks that prove two people actually see each other
// move, that the server stays authoritative, and that a disconnect cleans up.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { io as ioClient } from 'socket.io-client'
import { createServer } from '../index.js'
import { parseConfig } from '../config/env.js'
import { createLogger } from '../lib/logger.js'
import { ERROR_CODES, EVENTS, LIMITS } from '../../../shared/protocol.js'

const FRONTEND_ORIGIN = 'http://localhost:5173'
const WAIT_TIMEOUT_MS = 5000

let httpServer
let baseUrl
let registry
let realtime
let stats
/** @type {Set<import('socket.io-client').Socket>} */
const clients = new Set()

beforeAll(async () => {
  const config = parseConfig({ NODE_ENV: 'test', CORS_ORIGIN: FRONTEND_ORIGIN, MONGODB_URI: '' })
  const created = createServer({ config, logger: createLogger({ level: 'error', scope: 'test', sink: { write() {} } }) })
  httpServer = created.httpServer
  registry = created.registry
  realtime = created.realtime
  stats = created.realtime.stats

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

afterEach(async () => {
  // Every test starts from an empty room: disconnect and wait for the server to
  // process the removals.
  for (const socket of clients) socket.disconnect()
  const deadline = Date.now() + 2000
  while (registry.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  clients.clear()
  expect(registry.size, 'registry should be empty between tests').toBe(0)
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

// ---------------------------------------------------------------- helpers ---

function connectClient() {
  const socket = ioClient(baseUrl, { transports: ['websocket'], reconnection: false, timeout: WAIT_TIMEOUT_MS })
  clients.add(socket)
  return socket
}

function waitForEvent(socket, event, { timeout = WAIT_TIMEOUT_MS, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timed out waiting for "${event}"`))
    }, timeout)
    function handler(payload) {
      if (!filter(payload)) return
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

function recordEvents(socket, event) {
  const received = []
  socket.on(event, (payload) => received.push(payload))
  return received
}

/** Connect and join; resolves with the client, its snapshot and its player record. */
async function joinPlayer(name) {
  const socket = connectClient()
  const snapshotPromise = waitForEvent(socket, EVENTS.SNAPSHOT)
  await waitForEvent(socket, 'connect')
  socket.emit(EVENTS.JOIN, { name })
  const snapshot = await snapshotPromise
  return { socket, snapshot, player: snapshot.self }
}

const waitForCondition = async (predicate, label = 'condition', timeout = 2000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ------------------------------------------------------------------ tests ---

describe('joining', () => {
  it('gives a newcomer a server-generated identity and a valid initial position', async () => {
    const { player, snapshot } = await joinPlayer('Ada')

    expect(player.id).toMatch(/^[0-9a-f-]{36}$/) // server-minted UUID
    expect(player.name).toBe('Ada')
    expect(typeof player.joinedAt).toBe('number')
    expect(player.moving).toBe(false)
    // inside the walkable world
    expect(player.x).toBeGreaterThanOrEqual(LIMITS.WALKABLE_X)
    expect(player.y).toBeGreaterThanOrEqual(LIMITS.WALKABLE_Y)
    expect(player.x).toBeLessThanOrEqual(LIMITS.WALKABLE_X + LIMITS.WALKABLE_WIDTH)
    expect(player.y).toBeLessThanOrEqual(LIMITS.WALKABLE_Y + LIMITS.WALKABLE_HEIGHT)
    expect(snapshot.players).toEqual([])
    expect(snapshot.version).toBe(1)
    expect(snapshot.room.id).toBe('proxispeak-lobby')
  })

  it('sends the existing roster to the newcomer and announces the newcomer to the room', async () => {
    const first = await joinPlayer('Ada')
    const joinedNotice = waitForEvent(first.socket, EVENTS.JOINED)

    const second = await joinPlayer('Grace')

    // newcomer sees everyone who was already there
    expect(second.snapshot.players.map((player) => player.id)).toEqual([first.player.id])
    expect(second.snapshot.players[0].name).toBe('Ada')

    // and the room is told about the newcomer
    const notice = await joinedNotice
    expect(notice.player.id).toBe(second.player.id)
    expect(notice.player.name).toBe('Grace')
    expect(registry.size).toBe(2)
  })

  it('ignores client-supplied identity and room membership', async () => {
    const socket = connectClient()
    const snapshotPromise = waitForEvent(socket, EVENTS.SNAPSHOT)
    await waitForEvent(socket, 'connect')
    socket.emit(EVENTS.JOIN, { name: 'Mallory', id: 'admin-1', room: 'secret-room', roomId: 'secret-room' })
    const snapshot = await snapshotPromise

    expect(snapshot.self.id).not.toBe('admin-1')
    expect(snapshot.self.name).toBe('Mallory')
    expect(snapshot.room.id).toBe('proxispeak-lobby')
    // the spoofed room was never joined
    const rooms = [...(httpServer._events?.connection ? [] : [])]
    expect(rooms).toEqual([])
  })

  it('rejects invalid display names without registering anything', async () => {
    const socket = connectClient()
    await waitForEvent(socket, 'connect')

    for (const name of ['', '   ', 'x'.repeat(LIMITS.NAME_MAX_LENGTH + 1), 42, null, '<b>bold</b>']) {
      const error = waitForEvent(socket, EVENTS.ERROR)
      socket.emit(EVENTS.JOIN, { name })
      const payload = await error
      expect(payload.code).toBe(ERROR_CODES.INVALID_NAME)
    }
    expect(registry.size).toBe(0)
  })

  it('never registers the same socket twice and does not re-announce it', async () => {
    const { socket, player } = await joinPlayer('Ada')
    const joinedEvents = recordEvents(socket, EVENTS.JOINED)

    // identical name: a no-op
    socket.emit(EVENTS.JOIN, { name: 'Ada' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(registry.size).toBe(1)
    expect(registry.getById(player.id).id).toBe(player.id)
    expect(joinedEvents).toHaveLength(0)

    // different name: a rename of the same player, announced once as an upsert
    const renamed = waitForEvent(socket, EVENTS.JOINED)
    socket.emit(EVENTS.JOIN, { name: 'Ada Lovelace' })
    const payload = await renamed
    expect(payload.player.id).toBe(player.id)
    expect(payload.player.name).toBe('Ada Lovelace')
    expect(registry.size).toBe(1)
    expect(stats.renames).toBeGreaterThan(0)
  })

  it('refuses to exceed the room capacity', async () => {
    // Fill the room with bare registry entries (faster than 24 real sockets).
    const filled = []
    for (let i = 0; i < LIMITS.MAX_PLAYERS_PER_ROOM; i += 1) {
      filled.push(registry.add({ socketId: `fake-socket-${i}`, name: `Player ${i}` }))
    }
    expect(registry.size).toBe(LIMITS.MAX_PLAYERS_PER_ROOM)

    const socket = connectClient()
    await waitForEvent(socket, 'connect')
    const error = waitForEvent(socket, EVENTS.ERROR)
    socket.emit(EVENTS.JOIN, { name: 'Late' })
    expect((await error).code).toBe(ERROR_CODES.ROOM_FULL)

    for (const entry of filled) registry.remove(entry.player.id.startsWith('') ? `fake-socket-${filled.indexOf(entry)}` : '')
    registry.clear()
  })
})

describe('movement', () => {
  it('broadcasts a validated move to the other client and keeps the server authoritative', async () => {
    const ada = await joinPlayer('Ada')
    const grace = await joinPlayer('Grace')

    const moved = waitForEvent(grace.socket, EVENTS.MOVED)
    const target = { x: ada.player.x - 12, y: ada.player.y - 4 }
    ada.socket.emit(EVENTS.MOVE, { ...target, dir: 3.1, moving: true, clientTs: Date.now() })

    const update = await moved
    expect(update.id).toBe(ada.player.id)
    expect(update.x).toBeCloseTo(target.x, 2)
    expect(update.y).toBeCloseTo(target.y, 2)
    expect(update.dir).toBeCloseTo(3.1, 2)
    expect(update.moving).toBe(true)
    expect(update.serverTs).toBeGreaterThan(0)

    // the server stored exactly what it broadcast
    expect(registry.getById(ada.player.id)).toMatchObject({ x: target.x, y: target.y, moving: true })
  })

  it('synchronises movement in both directions', async () => {
    const ada = await joinPlayer('Ada')
    const grace = await joinPlayer('Grace')

    const adaSeesGrace = waitForEvent(ada.socket, EVENTS.MOVED)
    const graceSeesAda = waitForEvent(grace.socket, EVENTS.MOVED)

    grace.socket.emit(EVENTS.MOVE, { x: grace.player.x, y: grace.player.y - 10, dir: -1.5, moving: true })
    ada.socket.emit(EVENTS.MOVE, { x: ada.player.x + 8, y: ada.player.y, dir: 0, moving: true })

    expect((await adaSeesGrace).id).toBe(grace.player.id)
    expect((await graceSeesAda).id).toBe(ada.player.id)
  })

  it('requires a join before moving', async () => {
    const socket = connectClient()
    await waitForEvent(socket, 'connect')
    const error = waitForEvent(socket, EVENTS.ERROR)
    socket.emit(EVENTS.MOVE, { x: 1280, y: 1400, dir: 0, moving: true })
    expect((await error).code).toBe(ERROR_CODES.JOIN_REQUIRED)
    expect(registry.size).toBe(0)
  })

  it('rejects malformed and hostile payloads without moving the player', async () => {
    const ada = await joinPlayer('Ada')
    const grace = await joinPlayer('Grace')
    const broadcast = recordEvents(grace.socket, EVENTS.MOVED)

    const hostile = [
      { x: 1e12, y: 1e12, dir: 0, moving: true }, // absurd values
      { x: Number.POSITIVE_INFINITY, y: 0 }, // non-finite
      { x: '1280', y: '1400' }, // wrong types
      { x: 1280, y: 1400, dir: Number.NaN }, // non-finite facing
      { x: -50, y: 1400 }, // outside the world
      null,
      'not-an-object',
    ]

    // Paced ~90 ms apart so every payload reaches the validator: the limiter
    // refills one token per ~67 ms, and its warning is throttled to 1/s by design.
    const codes = []
    for (const payload of hostile) {
      const error = waitForEvent(ada.socket, EVENTS.ERROR)
      ada.socket.emit(EVENTS.MOVE, payload)
      codes.push((await error).code)
      await new Promise((resolve) => setTimeout(resolve, 90))
    }

    for (const code of codes) {
      expect([ERROR_CODES.INVALID_PAYLOAD, ERROR_CODES.INVALID_POSITION]).toContain(code)
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(broadcast).toHaveLength(0)
    // still exactly where it spawned
    expect(registry.getById(ada.player.id)).toMatchObject({ x: ada.player.x, y: ada.player.y })
  })

  it('rejects teleports and tells the client where it really is', async () => {
    const ada = await joinPlayer('Ada')
    const error = waitForEvent(ada.socket, EVENTS.ERROR)

    ada.socket.emit(EVENTS.MOVE, { x: 100, y: 120, dir: 0, moving: true })
    const correction = await error

    expect(correction.code).toBe(ERROR_CODES.INVALID_POSITION)
    expect(correction.data).toEqual({ x: ada.player.x, y: ada.player.y })
    expect(registry.getById(ada.player.id)).toMatchObject({ x: ada.player.x, y: ada.player.y })
  })

  it('caps movement updates at 15 per second and tells the client once', async () => {
    const ada = await joinPlayer('Ada')
    const before = stats.acceptedMoves
    const errors = recordEvents(ada.socket, EVENTS.ERROR)

    // A hostile burst: 120 updates fired as fast as possible, each a legal step.
    for (let i = 0; i < 120; i += 1) {
      ada.socket.emit(EVENTS.MOVE, {
        x: ada.player.x + 1 + i * 0.01,
        y: ada.player.y,
        dir: 0,
        moving: true,
        clientTs: Date.now(),
      })
    }
    await waitForCondition(() => stats.droppedByRateLimit > 0, 'rate limiting to kick in')
    await waitForCondition(() => errors.length > 0, 'the rate-limit warning')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const acceptedInBurst = stats.acceptedMoves - before
    // burst (5) plus whatever refilled during the burst window — never 120.
    expect(acceptedInBurst).toBeLessThan(30)
    expect(errors[0].code).toBe(ERROR_CODES.RATE_LIMITED)
    // warning is throttled: at most one per second
    expect(errors.length).toBeLessThanOrEqual(2)
  })

  it('ignores unknown events entirely', async () => {
    const ada = await joinPlayer('Ada')
    ada.socket.emit('totally:unknown', { anything: true })
    ada.socket.emit(EVENTS.MOVE, { x: ada.player.x, y: ada.player.y, dir: 1, moving: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(registry.size).toBe(1)
    expect(registry.getById(ada.player.id)).toBeTruthy()
  })
})

describe('disconnecting', () => {
  it('removes transient state and notifies the remaining clients', async () => {
    const ada = await joinPlayer('Ada')
    const grace = await joinPlayer('Grace')

    const left = waitForEvent(ada.socket, EVENTS.LEFT)
    grace.socket.disconnect()

    const payload = await left
    expect(payload.id).toBe(grace.player.id)
    expect(registry.size).toBe(1)
    expect(registry.getById(grace.player.id)).toBeNull() // no stale presence
  })

  it('notifies nobody when a socket that never joined disconnects', async () => {
    const ada = await joinPlayer('Ada')
    const announcements = recordEvents(ada.socket, EVENTS.LEFT)

    const lurker = connectClient()
    await waitForEvent(lurker, 'connect')
    lurker.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(announcements).toHaveLength(0)
    expect(registry.size).toBe(1)
  })

  it('keeps the room consistent when everyone leaves', async () => {
    const ada = await joinPlayer('Ada')
    const grace = await joinPlayer('Grace')
    expect(stats.joins).toBeGreaterThanOrEqual(2)

    ada.socket.disconnect()
    grace.socket.disconnect()
    await waitForCondition(() => registry.size === 0, 'the registry to empty out')
    expect(realtime.registry.list()).toEqual([])
  })
})
