// Observable store for world/HUD state.
//
// Deliberately coarse: the engine writes here at ~5 Hz (not every frame) and
// React re-renders only when a value actually changed. The animation loop itself
// never touches React — that separation is what keeps 60 fps independent of
// rendering the HUD.

const INITIAL_STATE = Object.freeze({
  engineReady: false,
  running: false,
  fps: 0,
  drawsPerSecond: 0,

  player: Object.freeze({ x: 0, y: 0, moving: false, facing: 'south', speed: 0 }),
  zoneName: '—',
  spawnId: null,

  zoom: 1,
  minZoom: 0.5,
  maxZoom: 2,
  follow: true,
  showLabels: true,
  followAvailable: true,

  nearbyCount: 0,
  peerCount: 0,
  lastError: null,
})

let state = INITIAL_STATE
const listeners = new Set()

function shallowEqual(a, b) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export const worldStore = {
  getSnapshot() {
    return state
  },

  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /**
   * Patch the store. The snapshot reference only changes when something really
   * changed, which is what `useSyncExternalStore` requires.
   */
  set(patch) {
    const next = { ...state, ...patch }
    if (shallowEqual(state, next)) return state
    state = Object.freeze(next)
    for (const listener of listeners) listener()
    return state
  },

  reset() {
    state = INITIAL_STATE
    for (const listener of listeners) listener()
  },
}
