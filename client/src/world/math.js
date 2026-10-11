// Pure math helpers used by the world engine and rendering.
// Frame-rate independent and side-effect free so they are unit-testable.

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  return a + d * t
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

// Smoothstep easing for camera follow and avatar interpolation.
export function smoothstep(t) {
  const c = clamp(t, 0, 1)
  return c * c * (3 - 2 * c)
}