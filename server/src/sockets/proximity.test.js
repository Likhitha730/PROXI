// Integration tests for the proximity feature over a real Socket.IO server with
// real clients: what a player is told about their neighbours, when they are told,
// and what happens when the database is broken.
//
// The database here is the documented in-process double (server/src/test/fakeMongo.js)
// — this sandbox has no mongod, so these tests exercise the real repository and
// handler code against double semantics, not against a live MongoDB.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { io as ioClient } from 'socket.io-client'
import { createServer } from '../index.js'
import { parseConfig } from '../config/env.js'
import { createLogger } from '../lib/logger.js'
import { createFakeDatabase, mongoErrors } from '../test/fakeMongo.js'
import { EVENTS, LIMITS } from '../../../shared/protocol.js'

const FRONTEND_ORIGIN = 'http://localhost:5173'
const WAIT_TIMEOUT_MS = 5000
const COLLECTION = 'positions'

let httpServer
let baseUrl
let registry
let proximity
let serverStats
let db
const clients = new Set()

beforeAll(async () => {
  const config = parseConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: FRONTEND_ORIGIN,
    MONGODB_URI: 'mongodb://127.0.0.1:27017/proxi_test',
    MONGODB_COLLECTION: COLLECTION,
    POSITION_FLUSH_MS: '250',
  })
  const logger = createLogger({ level: 'error', scope: 'test', sink: { write() {} } })

  db = createFakeDatabase()
  const created = createServer({ config, logger, getDatabase: () => db.database })
  httpServer = created.httpServer
  registry = created.registry
  proximity = created.realtime.proximity
  serverStats = created.realtime.stats

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

afterEach(async () => {
  for (const socket of clients) socket.disconnect()
  const deadline = Date.now() + 2000
  while (registry.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  clients.clear()
  db.reset()
  db.setFailure(null)
  proximity.reset()
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

// ------------------------------------------------------------------ helpers ---

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

const once = (socket, event, options) => waitForEvent(socket, event, options)

/** Join, wait for the snapshot, and return the self record. */
async function join(socket, name) {
  const snapshot = once(socket, EVENTS.SNAPSHOT)
  socket.emit(EVENTS.JOIN, { name })
  return (await snapshot).self
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Walk along a straight line the way a real client must: the server enforces a
 * speed limit (205 u/s + slack), so a single long jump is rejected. Steps stay well
 * inside the allowance, and the pause both keeps the elapsed-time budget comfortable
 * and exceeds the 4 Hz proximity interval, so the walker's own distances refresh too.
 */
async function walkTo(socket, from, to, { stepUnits = 45, pauseMs = 280 } = {}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(distance / stepUnits))
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    socket.emit(EVENTS.MOVE, {
      x: from.x + dx * progress,
      y: from.y + dy * progress,
      dir: 0,
      moving: true,
      clientTs: Date.now(),
    })
    await sleep(pauseMs)
  }
}

/**
 * Put a session at an exact position the way the server itself would after an
 * accepted move: through the registry, then publish the recomputed neighbourhoods.
 *
 * Repositioning over the wire would have to respect the server's speed limit
 * (proved in src/realtime/protocol.test.js and src/sockets/presence.test.js), which
 * would make every test here a matter of walking for seconds. This seam keeps the
 * *proximity* behaviour under test while movement validation stays covered elsewhere.
 */
function place(socketId, x, y) {
  registry.move(socketId, { x, y, moving: false })
  proximity.updateAll()
}

/** Wait until the collection holds a live record for this session, or give up. */
async function waitForStoredPosition(sessionId, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (db.documentsIn(COLLECTION).some((document) => document.sessionId === sessionId)) return true
    await sleep(20)
  }
  return false
}

// --------------------------------------------------------------------- tests ---

describe('proximity over the wire', () => {
  it('announces the documented event and radius', () => {
    expect(EVENTS.PROXIMITY).toBe('proximity:update')
    expect(LIMITS.PROXIMITY_RADIUS).toBe(100)
    // The full event list is asserted in src/realtime/protocol.test.js.
  })

  it('sends a joining player their nearby list, and never themselves', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1200, 1200)

    // Grace joins: joining itself announces her to Ada (membership change), and a
    // forced update tells Grace about Ada.
    const adaUpdate = once(ada, EVENTS.PROXIMITY, {
      filter: (payload) => payload.neighbours.some((entry) => entry.name === 'Grace'),
    })
    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1240, 1200) // 40 u from Ada

    const forAda = await adaUpdate
    const forGrace = await once(grace, EVENTS.PROXIMITY, {
      filter: (payload) => payload.neighbours.some((entry) => entry.name === 'Ada'),
    })

    expect(forAda.radius).toBe(100)
    expect(forAda.id).toBe(adaSelf.id)
    expect(forAda.neighbours.map((entry) => entry.name)).toEqual(['Grace'])
    expect(forAda.neighbours[0].distance).toBeCloseTo(40, 0)
    expect(forAda.neighbours[0]).toMatchObject({ nearby: true })

    // Grace's own result must never contain Grace.
    expect(forGrace.neighbours.some((entry) => entry.name === 'Grace')).toBe(false)
    expect(forGrace.id).toBe(graceSelf.id)
  })

  it('includes position and distance for every nearby user', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')

    const update = once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length > 0 })
    place(grace.id, 1030, 1040) // 3-4-5 → exactly 50 u
    const payload = await update

    expect(payload.neighbours).toHaveLength(1)
    expect(payload.neighbours[0]).toMatchObject({
      id: graceSelf.id,
      name: 'Grace',
      x: 1030,
      y: 1040,
      nearby: true,
    })
    expect(payload.neighbours[0].distance).toBeCloseTo(50, 0)
    expect(Number.isFinite(payload.at)).toBe(true)
  })

  it('drops a player from the nearby list as soon as they leave', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 800, 800)
    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')

    const arrived = once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })
    place(grace.id, 820, 800)
    await arrived

    const left = once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 0 })
    grace.disconnect()
    const payload = await left

    expect(payload.neighbours.some((entry) => entry.id === graceSelf.id)).toBe(false)
    expect(registry.size).toBe(1)
  })

  it('tells an existing player about a newcomer without waiting for them to move', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 600, 600)

    const update = once(ada, EVENTS.PROXIMITY, {
      filter: (payload) => payload.neighbours.some((entry) => entry.name === 'Newcomer'),
    })
    const newcomer = connectClient()
    await join(newcomer, 'Newcomer')
    place(newcomer.id, 610, 600)

    const payload = await update
    expect(payload.neighbours[0].distance).toBeCloseTo(10, 0)
  })

  it('tells a standing player when somebody walks into range (no move of their own)', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1800, 1200)

    const grace = connectClient()
    await join(grace, 'Grace')
    place(grace.id, 2100, 1200) // 300 u away: out of range, and Ada is never told

    // Ada sends nothing from here on. Grace walks in through the real movement path.
    const notice = once(ada, EVENTS.PROXIMITY, {
      filter: (payload) => payload.neighbours.some((entry) => entry.name === 'Grace'),
    })
    const arrive = once(grace, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })
    await walkTo(grace, { x: 2100, y: 1200 }, { x: 1870, y: 1200 })
    const payload = await notice

    expect(payload.neighbours.map((entry) => entry.name)).toEqual(['Grace'])
    expect(payload.neighbours[0].distance).toBeCloseTo(70, 0)
    expect((await arrive).neighbours[0].name).toBe('Ada')
  })

  it('never reports a player who is far away, and reports one right on the radius', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1400, 700)
    const edge = connectClient()
    await join(edge, 'Edge')

    // 101 u: outside. Nothing should be published, so listen for a short window.
    let seen = null
    const listener = (payload) => { seen = payload }
    ada.on(EVENTS.PROXIMITY, listener)
    place(edge.id, 1501, 700)
    await sleep(150)
    ada.off(EVENTS.PROXIMITY, listener)
    expect(seen?.neighbours ?? []).toHaveLength(0)

    // Exactly 100 u: inside (the documented inclusive boundary).
    const onEdge = once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })
    place(edge.id, 1500, 700)
    const payload = await onEdge
    expect(payload.neighbours[0].distance).toBe(100)
    expect(payload.neighbours[0].name).toBe('Edge')
  })

  it('throttles: standing still produces no repeated proximity traffic', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    await join(connectClient(), 'Grace')
    place(ada.id, 1600, 900)
    const grace = [...clients].at(-1)
    place(grace.id, adaSelf.x + 25, adaSelf.y)

    // Let the initial exchange settle.
    await sleep(300)
    let updates = 0
    const count = () => { updates += 1 }
    ada.on(EVENTS.PROXIMITY, count)

    // Re-send the same position repeatedly — the registry treats it as a no-op and
    // nothing should be recomputed or emitted.
    for (let index = 0; index < 10; index += 1) {
      ada.emit(EVENTS.MOVE, { x: 1600, y: 900, moving: false })
      grace.emit(EVENTS.MOVE, { x: 1625, y: 900, moving: false })
      await sleep(30)
    }
    ada.off(EVENTS.PROXIMITY, count)

    expect(updates).toBe(0)
    expect(serverStats.proximityUpdates).toBeGreaterThan(0)
  })

  it('keeps working when a client reconnects with a new session', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1000, 1400)

    let grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1015, 1400)
    await once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })

    // Reconnect: a brand new socket id, so a brand new session.
    grace.disconnect()
    await once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 0 })

    grace = connectClient()
    const reconnectedSelf = await join(grace, 'Grace')
    place(grace.id, 1015, 1400)

    const payload = await once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })
    expect(payload.neighbours[0].id).not.toBe(graceSelf.id) // new session id
    expect(payload.neighbours[0].id).toBe(reconnectedSelf.id)
    expect(payload.neighbours).toHaveLength(1) // no ghost of the old session
  })

  it('handles invalid movement without corrupting any nearby list', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    const grace = connectClient()
    await join(grace, 'Grace')
    place(grace.id, 1020, 1000)
    await once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })

    for (const payload of [{ x: 'nowhere', y: null }, { x: Number.NaN, y: 0 }, { x: 5000, y: 5000 }, null]) {
      const error = once(grace, EVENTS.ERROR)
      grace.emit(EVENTS.MOVE, payload)
      expect((await error).code).toMatch(/^invalid_/)
    }

    // Ada's list is untouched, and Grace is still exactly where she was.
    expect(proximity.resultFor(ada.id).neighbours).toHaveLength(1)
    expect(registry.get(grace.id).x).toBe(1020)
    expect(registry.get(grace.id).y).toBe(1000)
  })
})

describe('database failure tolerance', () => {
  it('keeps proximity working when every database call fails', async () => {
    db.failEverything(mongoErrors.timeout())

    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    const grace = connectClient()
    await join(grace, 'Grace')

    const update = once(ada, EVENTS.PROXIMITY, { filter: (payload) => payload.neighbours.length === 1 })
    place(grace.id, 1035, 1000)
    const payload = await update
    expect(payload.neighbours[0].distance).toBeCloseTo(35, 0)

    // The server is still healthy: a later join still gets a full snapshot listing
    // everyone else in the room (snapshot.players excludes the joiner themselves).
    const late = connectClient()
    const snapshot = once(late, EVENTS.SNAPSHOT)
    late.emit(EVENTS.JOIN, { name: 'Late' })
    const received = await snapshot
    expect(received.players.map((player) => player.name).sort()).toEqual(['Ada', 'Grace'])
    expect(received.self.name).toBe('Late')
    expect(serverStats.persistFailures).toBeGreaterThan(0)
  })

  it('counts persistence failures instead of throwing', async () => {
    db.failEverything(mongoErrors.notConnected())
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    ada.emit(EVENTS.MOVE, { x: adaSelf.x + 5, y: adaSelf.y + 5, moving: true })
    await sleep(150)

    expect(serverStats.persistFailures).toBeGreaterThan(0)
    expect(Number.isFinite(serverStats.persistedWrites)).toBe(true)
  })

  it('writes positions for joined players while the database is healthy', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    expect(await waitForStoredPosition(adaSelf.id)).toBe(true)

    const record = db.documentsIn(COLLECTION).find((document) => document.sessionId === adaSelf.id)
    expect(record.name).toBe('Ada')
    expect(record.location).toEqual([adaSelf.x, adaSelf.y])
    expect(record.connected).toBe(true)
    expect(record.schemaVersion).toBe(1)
    expect(record.updatedAt).toBeInstanceOf(Date)
    expect(record.firstSeenAt).toBeInstanceOf(Date)
  })

  it('marks a disconnected session as inactive without deleting the record', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    expect(await waitForStoredPosition(adaSelf.id)).toBe(true)

    ada.disconnect()
    const deadline = Date.now() + 2000
    while (registry.size > 0 && Date.now() < deadline) await sleep(20)

    const deadline2 = Date.now() + 2000
    let record
    while (Date.now() < deadline2) {
      record = db.documentsIn(COLLECTION).find((document) => document.sessionId === adaSelf.id)
      if (record && record.connected === false) break
      await sleep(20)
    }
    expect(record).toBeTruthy()
    expect(record.connected).toBe(false)
  })

  it('recovers persistence when the database comes back', async () => {
    db.failEverything(mongoErrors.timeout())
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    expect(await waitForStoredPosition(adaSelf.id, 300)).toBe(false) // nothing stored while broken

    db.setFailure(null) // healed
    ada.emit(EVENTS.MOVE, { x: adaSelf.x + 12, y: adaSelf.y, moving: true })
    expect(await waitForStoredPosition(adaSelf.id)).toBe(true)
  })
})
