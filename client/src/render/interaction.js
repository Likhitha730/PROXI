// Interaction + motion helpers for the 2D view.
//
// Kept pure (no canvas, no DOM beyond an injected `matchMedia`) so the rules that
// decide "which avatar did I click" and "how does a speaking indicator ease in" are
// unit-testable rather than only observable by eye.

/**
 * Pick the avatar under a world-space point.
 *
 * Works in **world coordinates**: the caller converts the pointer with the camera
 * transform, so picking stays correct at every zoom level. The engine scales the
 * hit radius by 1/zoom, which keeps the *screen* target roughly the same size while
 * the geometry stays in world units.
 *
 * @param {{x:number,y:number}} worldPoint
 * @param {Iterable<{id:string,x:number,y:number}>} avatars
 * @param {{worldRadius?:number, exclude?:string|null}} [options]
 * @returns {object|null} the nearest avatar inside the radius, or null
 */
export function pickAvatar(worldPoint, avatars, { worldRadius = 22, exclude = null } = {}) {
  if (!worldPoint || !Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y)) return null
  if (!Number.isFinite(worldRadius) || worldRadius <= 0) return null

  let best = null
  let bestDistance = worldRadius
  for (const avatar of avatars ?? []) {
    if (!avatar || avatar.id === exclude) continue
    if (!Number.isFinite(avatar.x) || !Number.isFinite(avatar.y)) continue
    const distance = Math.hypot(avatar.x - worldPoint.x, avatar.y - worldPoint.y)
    if (distance <= bestDistance) {
      best = avatar
      bestDistance = distance
    }
  }
  return best
}

/**
 * Frame-rate independent easing toward a target, with separate rates for rising and
 * falling values.
 *
 * Used for the speaking indicator: it should appear promptly when somebody starts
 * talking (attack) but decay gently when they stop (release), so the ring does not
 * flicker between words. `dt` is clamped, so a stalled tab cannot teleport the value.
 *
 * @returns {number} the next value, always between the current value and the target
 */
export function smoothTowards(current, target, dt, { attack = 14, release = 5 } = {}) {
  const from = Number.isFinite(current) ? current : 0
  const to = Number.isFinite(target) ? target : 0
  const step = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1)
  const rate = to > from ? attack : release
  const next = from + (to - from) * (1 - Math.exp(-rate * step))
  if (Math.abs(next - to) < 0.001) return to
  return Math.max(0, Math.min(1, next))
}

/**
 * Reduced-motion preference, read from the OS.
 *
 * Ambient sway, dashed ring motion and pulsing indicators are all decorative: when
 * the user asks their system for less motion, they stop. Nothing here disables the
 * information itself — the speaking ring stays visible, it just stops animating.
 */
export function createMotionPreference({ matchMedia = globalThis.matchMedia, query = '(prefers-reduced-motion: reduce)' } = {}) {
  let list = null
  try {
    list = matchMedia?.(query) ?? null
  } catch {
    list = null
  }

  let reduced = Boolean(list?.matches)
  let onChange = null

  function attach(listener) {
    onChange = listener
    // `addEventListener` is the modern API; older Safari only has addListener.
    list?.addEventListener?.('change', handleChange)
    list?.addListener?.(handleChange)
  }

  function handleChange(event) {
    reduced = Boolean(event?.matches)
    onChange?.(reduced)
  }

  return {
    get reduced() {
      return reduced
    },
    get supported() {
      return Boolean(list)
    },
    subscribe(listener) {
      if (onChange) return () => {}
      attach(listener)
      return () => {
        list?.removeEventListener?.('change', handleChange)
        list?.removeListener?.(handleChange)
        onChange = null
      }
    },
    dispose() {
      list?.removeEventListener?.('change', handleChange)
      list?.removeListener?.(handleChange)
      onChange = null
    },
  }
}
