/**
 * Socket client wiring tests.
 *
 * `socket.io-client` is replaced by a recording fake, so these tests assert the
 * *protocol behaviour* of the client: what it emits, which listeners it binds
 * (exactly once each), and how server events reach the presence store.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENTS, LIMITS } from '../../../shared/protocol.js'

/** Minimal recording stand-in for a Socket.IO client socket. */
function createFakeSocket() {
  const listeners = new Map()
  const managerListeners = new Map()
  const emitted = []

  const socket = {
    id: 'socket-abc',
    connected: false,
    connectCalls: 0,
    emitted,
    listeners,
    managerListeners,
    io: {
      engine: { transport: { name: 'websocket' } },
      on(event, handler) {
        if (!managerListeners.has(event)) managerListeners.set(event, [])
        managerListeners.get(event).push(handler)
      },
      removeAllListeners() {
        managerListeners.clear()
      },
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return socket
    },
    off(event, handler) {
      const list = listeners.get(event) ?? []
      listeners.set(
        event,
        list.filter((entry) => entry !== handler),
      )
      return socket
    },
    removeAllListeners() {
      listeners.clear()
      return socket
    },
    emit(event, payload) {
      emitted.push({ event, payload })
      return socket
    },
    connect() {
      // Real socket.io connects asynchronously; tests finish the handshake with
      // simulateConnect() so the ordering is explicit.
      socket.connectCalls += 1
    },
    simulateConnect() {
      socket.connected = true
      socket.trigger('connect')
    },
    disconnect() {
      socket.connected = false
      socket.trigger('disconnect', 'io client disconnect')
    },
    trigger(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    countListeners(event) {
      return (listeners.get(event) ?? []).length
    },
    emittedOf(event) {
      return emitted.filter((entry) => entry.event === event).map((entry) => entry.payload)
    },
  }

  return socket
}

const ioMock = vi.fn(() => currentSocket)
let currentSocket = createFakeSocket()

vi.mock('socket.io-client', () => ({
  io: (...args) => ioMock(...args),
}))

const { connectionStore } = await import('../state/connectionStore.js')
const { presence } = await import('./presence.js')
const socketClient = await import('./socketClient.js')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  currentSocket = createFakeSocket()
  ioMock.mockClear()
  currentSocket = createFakeSocket()
  connectionStore.reset()
  presence.reset()
  globalThis.localStorage?.clear?.()
})

afterEach(() => {
  socketClient.destroySocket()
})

describe('proximity wiring', () => {
  it('binds exactly one proximity listener and forwards it into presence', async () => {
    socketClient.connect()
    currentSocket.simulateConnect()
    await flush()

    expect(currentSocket.countListeners(EVENTS.PROXIMITY)).toBe(1)

    currentSocket.trigger(EVENTS.SNAPSHOT, {
      self: { id: 'self-1', name: 'Me', x: 1280, y: 1500 },
      players: [{ id: 'player-a', name: 'Ada', x: 1300, y: 1500, dir: 0, moving: false }],
      room: { id: 'proxispeak-lobby' },
    })
    currentSocket.trigger(EVENTS.PROXIMITY, {
      id: 'self-1',
      radius: 100,
      at: Date.now(),
      neighbours: [{ id: 'player-a', name: 'Ada', x: 1300, y: 1500, distance: 20, nearby: true }],
    })

    expect(presence.getProximity()).toMatchObject({ radius: 100, count: 1 })
    expect(presence.getSnapshot().proximity.nearby[0]).toMatchObject({ name: 'Ada', distance: 20 })
  })

  it('drops nearby state when the connection is lost', async () => {
    socketClient.connect()
    currentSocket.simulateConnect()
    await flush()
    currentSocket.trigger(EVENTS.PROXIMITY, { radius: 100, neighbours: [{ id: 'p', name: 'P', distance: 5 }] })
    expect(presence.getProximity().count).toBe(1)

    currentSocket.disconnect()
    expect(presence.getProximity()).toMatchObject({ radius: 100, count: 0 })
  })
})

describe('connection lifecycle', () => {
  it('creates exactly one socket and never double-subscribes on repeated connects', () => {
    socketClient.connect()
    socketClient.connect()
    socketClient.connect()

    expect(ioMock).toHaveBeenCalledTimes(1)
    // one listener per protocol event, no matter how often connect() is called
    for (const event of [EVENTS.SNAPSHOT, EVENTS.JOINED, EVENTS.MOVED, EVENTS.LEFT, EVENTS.PROXIMITY, EVENTS.ERROR]) {
      expect(currentSocket.countListeners(event), event).toBe(1)
    }
    expect(currentSocket.countListeners('connect')).toBe(1)
    expect(currentSocket.countListeners('disconnect')).toBe(1)
  })

  it('announces itself with player:join as soon as the transport connects', async () => {
    socketClient.connect()
    currentSocket.simulateConnect()
    await flush()

    const joins = currentSocket.emittedOf(EVENTS.JOIN)
    expect(joins).toHaveLength(1)
    expect(joins[0].name).toBe(socketClient.getDisplayName())
    expect(connectionStore.getSnapshot().status).toBe('connected')
  })

  it('re-joins after a reconnect, clearing stale presence first', async () => {
    socketClient.connect()
    currentSocket.simulateConnect()
    presence.applyJoined({ player: { id: 'other', name: 'Ghost', x: 1, y: 1 } })
    expect(presence.peerCount).toBe(1)

    currentSocket.disconnect()
    expect(presence.peerCount).toBe(0)
    expect(connectionStore.getSnapshot().status).toBe('disconnected')

    currentSocket.simulateConnect()
    await flush()
    expect(currentSocket.emittedOf(EVENTS.JOIN)).toHaveLength(2)
  })

  it('reports connection errors without throwing', () => {
    socketClient.connect()
    currentSocket.trigger('connect_error', new Error('boom'))
    expect(connectionStore.getSnapshot().status).toBe('error')
    expect(connectionStore.getSnapshot().lastError).toBe('boom')
    expect(presence.peerCount).toBe(0)
  })
})

describe('server events feed the presence model', () => {
  beforeEach(() => {
    socketClient.connect()
    currentSocket.simulateConnect()
  })

  it('applies the roster snapshot', () => {
    currentSocket.trigger(EVENTS.SNAPSHOT, {
      self: { id: 'self', name: 'Me', x: 1280, y: 1500, dir: 0, moving: false },
      players: [{ id: 'peer-1', name: 'Ada', x: 900, y: 800, dir: 0, moving: false }],
      room: { id: 'proxispeak-lobby', maxPlayers: LIMITS.MAX_PLAYERS_PER_ROOM },
    })

    const snapshot = presence.getSnapshot()
    expect(snapshot.ready).toBe(true)
    expect(snapshot.count).toBe(2)
    expect(snapshot.players).toEqual([{ id: 'peer-1', name: 'Ada' }])
  })

  it('tracks joins, movement and leaves', () => {
    currentSocket.trigger(EVENTS.SNAPSHOT, { self: { id: 'self', name: 'Me', x: 1280, y: 1500 }, players: [], room: { id: 'lobby' } })
    currentSocket.trigger(EVENTS.JOINED, { player: { id: 'peer-1', name: 'Ada', x: 900, y: 800, dir: 1 } })
    expect(presence.getSnapshot().count).toBe(2)

    for (let i = 0; i < 5; i += 1) {
      currentSocket.trigger(EVENTS.MOVED, { id: 'peer-1', x: 900 + i, y: 800, dir: 1, moving: true })
    }
    expect(presence.moveCount).toBe(5)

    currentSocket.trigger(EVENTS.LEFT, { id: 'peer-1' })
    expect(presence.getSnapshot().count).toBe(1)
    expect(presence.getSnapshot().players).toEqual([])
  })

  it('surfaces a rejected position as a correction and other errors as messages', () => {
    currentSocket.trigger(EVENTS.SNAPSHOT, { self: { id: 'self', name: 'Me', x: 1280, y: 1500 }, players: [], room: { id: 'lobby' } })

    currentSocket.trigger(EVENTS.ERROR, { code: 'invalid_position', message: 'position rejected', data: { x: 1200, y: 1300 } })
    expect(presence.takeCorrection()).toEqual({ x: 1200, y: 1300 })

    currentSocket.trigger(EVENTS.ERROR, { code: 'rate_limited', message: 'too fast' })
    expect(presence.getSnapshot().lastError).toMatchObject({ code: 'rate_limited' })
  })
})

describe('publishing movement', () => {
  it('emits player:move with the full payload while connected', () => {
    socketClient.connect()
    currentSocket.simulateConnect()

    expect(socketClient.sendMove({ x: 1200.456, y: 1300.654, dir: 1.2, moving: true })).toBe(true)
    const [payload] = currentSocket.emittedOf(EVENTS.MOVE)
    expect(payload).toMatchObject({ x: 1200.456, y: 1300.654, dir: 1.2, moving: true })
    expect(typeof payload.clientTs).toBe('number')
  })

  it('drops movement when there is no live session', () => {
    socketClient.connect() // handshake still in flight: nothing may be published
    expect(currentSocket.connected).toBe(false)
    expect(socketClient.sendMove({ x: 1, y: 1, dir: 0, moving: true })).toBe(false)
    expect(currentSocket.emittedOf(EVENTS.MOVE)).toHaveLength(0)
  })

  it('renames through a re-join and remembers the name locally', async () => {
    socketClient.connect()
    currentSocket.simulateConnect()

    socketClient.setDisplayName('Ada Lovelace')
    await flush()
    const joins = currentSocket.emittedOf(EVENTS.JOIN)
    expect(joins.at(-1)).toEqual({ name: 'Ada Lovelace' })
    expect(socketClient.getDisplayName()).toBe('Ada Lovelace')
    expect(globalThis.localStorage.getItem('proxispeak.displayName')).toBe('Ada Lovelace')

    // an empty rename is ignored rather than clearing the name
    socketClient.setDisplayName('   ')
    expect(socketClient.getDisplayName()).toBe('Ada Lovelace')
  })
})

describe('teardown', () => {
  it('destroys the socket, its listeners and the presence state', () => {
    socketClient.connect()
    currentSocket.simulateConnect()
    presence.applyJoined({ player: { id: 'peer-1', name: 'Ada', x: 1, y: 1 } })

    socketClient.destroySocket()

    expect(currentSocket.countListeners('connect')).toBe(0)
    expect(currentSocket.managerListeners.size).toBe(0)
    expect(presence.peerCount).toBe(0)
    expect(connectionStore.getSnapshot().status).toBe('idle')

    // a later connect builds a fresh socket rather than reusing the dead one
    currentSocket = createFakeSocket()
    socketClient.connect()
    expect(ioMock).toHaveBeenCalledTimes(2)
  })
})
