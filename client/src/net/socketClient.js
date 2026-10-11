// Socket.IO client wrapper — the only place in the frontend that owns a socket.
//
// Responsibilities:
//  - create exactly one socket (module singleton, StrictMode safe)
//  - translate Socket.IO lifecycle events into connectionStore updates
//  - keep reconnect/backoff policy in one place
//
// It never touches the canvas or React; the HUD observes the store instead.

import { io } from 'socket.io-client'
import { env } from '../config/env.js'
import { connectionStore } from '../state/connectionStore.js'

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

let socket = null

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
  })

  activeSocket.on('disconnect', (reason) => {
    connectionStore.set({
      status: reason === 'io client disconnect' ? 'disconnected' : 'error',
      socketId: null,
      transport: null,
      connectedAt: null,
      disconnectedReason: reason,
    })
  })

  activeSocket.on('connect_error', (error) => {
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

/** Create the socket on first use and return it thereafter. */
export function getSocket() {
  if (socket) return socket

  socket = io(env.socketUrl || undefined, socketOptions())
  bindLifecycle(socket)
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

/** Tears the connection down and drops the singleton (used by tests/teardown). */
export function destroySocket() {
  if (!socket) return
  socket.removeAllListeners()
  socket.io.removeAllListeners()
  socket.disconnect()
  socket = null
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
