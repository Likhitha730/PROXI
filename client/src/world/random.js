// Deterministic pseudo-random helpers.
//
// Used for procedural detail (leaf clusters, avatar appearance). Everything is
// derived from a stable seed — an id string or a number — so the same avatar or
// plant looks identical on every client and after every reload, which is what
// makes procedural art usable in a multiplayer world.

/** FNV-1a hash → unsigned 32-bit integer. */
export function hashString(input) {
  let hash = 0x811c9dc5
  const text = String(input)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32 — small, fast, good enough for visuals. */
export function createRng(seed) {
  let state = typeof seed === 'string' ? hashString(seed) : (seed >>> 0) || 1
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Convenience wrapper with range/dice helpers. */
export function createRngKit(seed) {
  const next = createRng(seed)
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (probability) => next() < probability,
  }
}
