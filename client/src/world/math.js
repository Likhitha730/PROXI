// Pure math helpers used by the world engine and rendering.
// Frame-rate independent and side-effect free so they are unit-testable.

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `lerp(a, b, t)` with a fixed `t` moves faster at high frame rates; this variant
 * converges at the same real-world speed regardless of delta time, which is what
 * movement, camera follow and zoom easing use.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} lambda higher = snappier (1/seconds)
 * @param {number} dt seconds since the previous frame
 */
export function damp(current, target, lambda, dt) {
  if (dt <= 0) return current
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

export function lerpAngle(a, b, t) {
  const d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  return a + d * t
}

/** Angle-aware frame-rate independent smoothing (shortest way around). */
export function dampAngle(current, target, lambda, dt) {
  if (dt <= 0) return current
  const delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI
  return current + delta * (1 - Math.exp(-lambda * dt))
}

export function dist(ax, ay, bx, by) {
  const dx = ax - bx
  const dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

export function normalize(dx, dy) {
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: 0, y: 0 }
  return { x: dx / len, y: dy / len }
}

/** Smoothstep easing for camera follow and avatar interpolation. */
export function smoothstep(t) {
  const c = clamp(t, 0, 1)
  return c * c * (3 - 2 * c)
}

/** Wrap a value into [0, period). */
export function wrap(value, period) {
  if (period <= 0) return 0
  return ((value % period) + period) % period
}

/** Snap an angle (radians) to one of `steps` evenly spaced directions. */
export function quantizeAngle(angle, steps = 8) {
  const step = (Math.PI * 2) / steps
  return wrap(Math.round(angle / step) * step, Math.PI * 2)
}

/** Compass-like 8-way index for an angle: 0 = east, 2 = south, 4 = west, 6 = north. */
export function directionIndex(angle, steps = 8) {
  const step = (Math.PI * 2) / steps
  return Math.round(wrap(angle, Math.PI * 2) / step) % steps
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function containsPoint(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}
