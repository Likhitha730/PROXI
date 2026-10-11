// Collision utilities: circle (avatar) vs axis-aligned boxes (walls, furniture).
//
// Pure module: no DOM, no canvas, no network — fully unit-testable.
// Movement is resolved axis-by-axis (move x, resolve; move y, resolve), which is
// cheap, stable and lets the avatar slide along walls instead of sticking.

import { clamp } from './math.js'

/** Half-open overlap test between a circle and an AABB. */
export function circleHitsBox(cx, cy, radius, box) {
  const nearestX = clamp(cx, box.x, box.x + box.w)
  const nearestY = clamp(cy, box.y, box.y + box.h)
  const dx = cx - nearestX
  const dy = cy - nearestY
  return dx * dx + dy * dy < radius * radius
}

/** True when the circle overlaps any box in the list. */
export function circleHitsAny(cx, cy, radius, boxes) {
  for (const box of boxes) {
    if (circleHitsBox(cx, cy, radius, box)) return box
  }
  return null
}

/**
 * Resolve a single-axis movement against the world.
 *
 * @param {object} params
 * @param {number} params.x current centre x
 * @param {number} params.y current centre y
 * @param {number} params.dx movement on x (already scaled by delta time)
 * @param {number} params.dy movement on y
 * @param {number} params.radius avatar radius
 * @param {Array<{x:number,y:number,w:number,h:number}>} params.colliders solid boxes
 * @param {{x:number,y:number,w:number,h:number}} params.bounds walkable world bounds
 * @returns {{x:number, y:number, blockedX:boolean, blockedY:boolean}}
 */
export function resolveMovement({ x, y, dx, dy, radius, colliders, bounds }) {
  let nextX = x
  let nextY = y
  let blockedX = false
  let blockedY = false

  // --- x axis -----------------------------------------------------------------
  if (dx !== 0) {
    const candidateX = clamp(x + dx, bounds.x + radius, bounds.x + bounds.w - radius)
    if (circleHitsAny(candidateX, y, radius, colliders)) {
      blockedX = true
    } else {
      nextX = candidateX
    }
    if (candidateX !== x + dx) blockedX = true // clamped by the world bounds
  }

  // --- y axis -----------------------------------------------------------------
  if (dy !== 0) {
    const candidateY = clamp(y + dy, bounds.y + radius, bounds.y + bounds.h - radius)
    if (circleHitsAny(nextX, candidateY, radius, colliders)) {
      blockedY = true
    } else {
      nextY = candidateY
    }
    if (candidateY !== y + dy) blockedY = true
  }

  return { x: nextX, y: nextY, blockedX, blockedY }
}

/** Walkability probe used by spawn validation and tests. */
export function isWalkable(cx, cy, radius, colliders, bounds) {
  if (cx - radius < bounds.x || cx + radius > bounds.x + bounds.w) return false
  if (cy - radius < bounds.y || cy + radius > bounds.y + bounds.h) return false
  return circleHitsAny(cx, cy, radius, colliders) === null
}
