// Tiny observable store for the Socket.IO connection state.
//
// Deliberately dependency-free (no Redux/Zustand) and React-free: `net/` writes
// into it, the HUD reads from it through `useSyncExternalStore`. The snapshot
// reference only changes when a value actually changes, which is what
// useSyncExternalStore requires to avoid infinite re-renders.

/** @typedef {'idle'|'connecting'|'connected'|'disconnected'|'error'} ConnectionStatus */

const INITIAL_STATE = Object.freeze({
  /** @type {ConnectionStatus} */
  status: 'idle',
  socketId: null,
  transport: null,
  attempts: 0,
  connectedAt: null,
  disconnectedReason: null,
  lastError: null,
})

let state = INITIAL_STATE
const listeners = new Set()

function emit() {
  for (const listener of listeners) listener()
}

export const connectionStore = {
  getSnapshot() {
    return state
  },

  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Patch the state; identical values are ignored so no re-render is triggered. */
  set(patch) {
    let changed = false
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] !== value) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...patch }
    emit()
  },

  reset() {
    state = INITIAL_STATE
    emit()
  },
}
