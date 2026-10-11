// Socket.IO client wrapper — the only place in the frontend that owns a socket.
//
// Responsibilities:
//  - create exactly one socket (module singleton, StrictMode safe)
//  - translate Socket.IO lifecycle events into connectionStore updates
//  - speak the ProxiSpeak protocol (shared/protocol.js): join on connect, forward
//    presence events into `presence`, and publish local movement
//  - keep reconnect/backoff policy in one place
//
// It never touches the canvas or React: the engine pulls interpolated peers from
// `presence` and the HUD observes the stores.

import { io } from 'socket.io-client'
import { EVENTS, LIMITS } from '../../../shared/protocol.js'
import { env } from '../config/env.js'
import { connectionStore } from '../state/connectionStore.js'
import { presence } from './presence.js'

const SOCKET_OPTIONS = Object.freeze({
  path: '/socket.io',
  // WebSocket preferred, polling kept as the documented fallback transport.
  transports: ['websocket', 'polling'],
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  timeout: 8000,
})

const NAME_STORAGE_KEY = 'proxispeak.displayName'

let socket = null
let displayName = readStoredName() ?? defaultName()

/**
 * socket.io-client mutates the options object it receives (it assigns
 * `opts.path`, for example), so it must be handed a fresh copy of the frozen
 * defaults — passing the frozen object itself throws in strict mode, which is
 * exactly how ES modules run in the browser.
 */
function socketOptions() {
  return { ...SOCKET_OPTIONS }
}

function transportName(activeSocket) {
  return activeSocket.io?.engine?.transport?.name ?? null
}

function readStoredName() {
  try {
    return globalThis.localStorage?.getItem(NAME_STORAGE_KEY) ?? null
  } catch {
    return null // storage can be blocked (private mode, third-party context)
  }
}

function storeName(name) {
  try {
    globalThis.localStorage?.setItem(NAME_STORAGE_KEY, name)
  } catch {
    /* best effort only */
  }
}

function defaultName() {
  return `Guest ${1000 + Math.floor(Math.random() * 9000)}`
}

/** The name this client will introduce itself with. */
export function getDisplayName() {
  return displayName
}

/**
 * Change the display name. If a session is live the server is told immediately
 * (a re-join is a rename server-side: same player, new label).
 */
export function setDisplayName(name) {
  const trimmed = String(name ?? '').trim().slice(0, LIMITS.NAME_MAX_LENGTH)
  if (!trimmed) return displayName
  displayName = trimmed
  storeName(trimmed)
  const activeSocket = socket
  if (activeSocket?.connected) activeSocket.emit(EVENTS.JOIN, { name: displayName })
  return displayName
}

function bindLifecycle(activeSocket) {
  activeSocket.on('connect', () => {
    connectionStore.set({
      status: 'connected',
      socketId: activeSocket.id ?? null,
      transport: transportName(activeSocket),
      connectedAt: Date.now(),
      disconnectedReason: null,
      lastError: null,
    })
    // A (re)connect is a brand-new server session: drop stale presence, then
    // introduce ourselves. The server replies with the roster snapshot.
    presence.reset()
    activeSocket.emit(EVENTS.JOIN, { name: displayName })
  })

  activeSocket.on('disconnect', (reason) => {
    presence.reset()
    connectionStore.set({
      status: reason === 'io client disconnect' ? 'disconnected' : 'error',
      socketId: null,
      transport: null,
      connectedAt: null,
      disconnectedReason: reason,
    })
  })

  activeSocket.on('connect_error', (error) => {
    presence.reset()
    connectionStore.set({
      status: 'error',
      socketId: null,
      transport: null,
      connectedAt: null,
      lastError: error?.message ?? 'Unknown connection error',
    })
  })

  // Manager-level events drive the "connecting / retrying" UI state.
  activeSocket.io.on('reconnect_attempt', (attempt) => {
    connectionStore.set({ status: 'connecting', attempts: attempt })
  })

  activeSocket.io.on('reconnect_error', (error) => {
    connectionStore.set({ status: 'error', lastError: error?.message ?? 'Reconnect failed' })
  })

  activeSocket.io.on('reconnect_failed', () => {
    connectionStore.set({
      status: 'error',
      lastError: 'Could not reach the backend after repeated attempts',
    })
  })

  activeSocket.io.on('error', (error) => {
    connectionStore.set({ lastError: error?.message ?? 'Transport error' })
  })
}

/**
 * Bind the presence protocol. Called once per socket instance, so a reconnect or
 * a StrictMode remount can never double-register listeners.
 */
function bindProtocol(activeSocket) {
  activeSocket.on(EVENTS.SNAPSHOT, (payload) => presence.applySnapshot(payload))
  activeSocket.on(EVENTS.JOINED, (payload) => presence.applyJoined(payload))
  activeSocket.on(EVENTS.MOVED, (update) => presence.applyMove(update))
  activeSocket.on(EVENTS.LEFT, (payload) => presence.applyLeft(payload))
  activeSocket.on(EVENTS.ERROR, (payload) => presence.applyError(payload))
}

/** Create the socket on first use and return it thereafter. */
export function getSocket() {
  if (socket) return socket

  socket = io(env.socketUrl || undefined, socketOptions())
  bindLifecycle(socket)
  bindProtocol(socket)
  connectionStore.set({ status: 'connecting', attempts: 0, lastError: null })
  return socket
}

/** Idempotent: safe to call from React effects (and from StrictMode remounts). */
export function connect() {
  const activeSocket = getSocket()
  if (!activeSocket.connected) {
    connectionStore.set({ status: 'connecting' })
    activeSocket.connect()
  }
  return activeSocket
}

/**
 * Publish a local movement sample. Called by the engine at up to
 * LIMITS.MOVE_UPDATES_PER_SECOND; silently dropped when there is no session.
 */
export function sendMove(state) {
  const activeSocket = socket
  if (!activeSocket?.connected) return false
  activeSocket.emit(EVENTS.MOVE, {
    x: state.x,
    y: state.y,
    dir: state.dir,
    moving: state.moving,
    clientTs: Date.now(),
  })
  return true
}

/** Tears the connection down and drops the singleton (used by tests/teardown). */
export function destroySocket() {
  if (!socket) return
  socket.removeAllListeners()
  socket.io.removeAllListeners()
  socket.disconnect()
  socket = null
  presence.reset()
  connectionStore.reset()
}

/** Reconnect after the user dismissed an error state. */
export function retry() {
  const activeSocket = getSocket()
  connectionStore.set({ status: 'connecting', lastError: null })
  if (activeSocket.connected) {
    activeSocket.disconnect()
  }
  activeSocket.connect()
  return activeSocket
}
