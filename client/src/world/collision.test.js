import { describe, expect, it } from 'vitest'
import { circleHitsAny, circleHitsBox, isWalkable, resolveMovement } from './collision.js'

const BOUNDS = { x: 0, y: 0, w: 1000, h: 1000 }
const RADIUS = 16

describe('circleHitsBox', () => {
  it('detects overlap on the box face and at the corner', () => {
    const box = { x: 100, y: 100, w: 50, h: 50 }
    expect(circleHitsBox(100, 125, RADIUS, box)).toBe(true) // touching the left face
    expect(circleHitsBox(103, 103, RADIUS, box)).toBe(true) // corner region
    expect(circleHitsBox(125, 125, RADIUS, box)).toBe(true) // fully inside
  })

  it('does not report a hit when the circle is clear', () => {
    const box = { x: 100, y: 100, w: 50, h: 50 }
    expect(circleHitsBox(60, 125, RADIUS, box)).toBe(false) // 40 units clear on x
    expect(circleHitsBox(125, 60, RADIUS, box)).toBe(false)
    expect(circleHitsBox(60, 60, RADIUS, box)).toBe(false) // clear on both axes
  })

  it('treats a circle inside the box as a hit', () => {
    const box = { x: 100, y: 100, w: 50, h: 50 }
    expect(circleHitsBox(125, 125, 4, box)).toBe(true)
  })

  it('uses the real radius at the boundary', () => {
    const box = { x: 100, y: 100, w: 50, h: 50 }
    expect(circleHitsBox(84.5, 125, RADIUS, box)).toBe(true) // 15.5 gap < 16 → touching
    expect(circleHitsBox(83.5, 125, RADIUS, box)).toBe(false) // 16.5 gap > 16 → clear
  })
})

describe('circleHitsAny', () => {
  it('returns the first blocking box or null', () => {
    const boxes = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 500, y: 500, w: 40, h: 40 },
    ]
    expect(circleHitsAny(520, 520, RADIUS, boxes)).toBe(boxes[1])
    expect(circleHitsAny(250, 250, RADIUS, boxes)).toBeNull()
  })
})

describe('resolveMovement', () => {
  const wall = [{ x: 300, y: 0, w: 40, h: 1000 }]

  it('moves freely in open space', () => {
    const result = resolveMovement({ x: 100, y: 100, dx: 10, dy: 5, radius: RADIUS, colliders: [], bounds: BOUNDS })
    expect(result).toEqual({ x: 110, y: 105, blockedX: false, blockedY: false })
  })

  it('blocks the axis that hits a wall but keeps the other axis (sliding)', () => {
    // 16 px radius, wall face at x = 300 → the player stops at x = 284
    const result = resolveMovement({
      x: 270,
      y: 200,
      dx: 30,
      dy: 12,
      radius: RADIUS,
      colliders: wall,
      bounds: BOUNDS,
    })
    expect(result.blockedX).toBe(true)
    expect(result.x).toBe(270) // x rejected entirely for this frame
    expect(result.y).toBe(212) // y still applied → sliding along the wall
    expect(result.blockedY).toBe(false)
  })

  it('clamps to the walkable bounds and reports the block', () => {
    const result = resolveMovement({ x: 20, y: 20, dx: -40, dy: -40, radius: RADIUS, colliders: [], bounds: BOUNDS })
    expect(result.x).toBe(RADIUS)
    expect(result.y).toBe(RADIUS)
    expect(result.blockedX).toBe(true)
    expect(result.blockedY).toBe(true)
  })

  it('never lets the avatar pass through a wall at high speed (tunnelling check)', () => {
    let position = { x: 100, y: 500 }
    for (let step = 0; step < 40; step += 1) {
      position = resolveMovement({
        ...position,
        dx: 60, // 60 units per frame would jump the 40-unit wall without collision checks
        dy: 0,
        radius: RADIUS,
        colliders: wall,
        bounds: BOUNDS,
      })
    }
    expect(position.x).toBeLessThanOrEqual(300 - RADIUS + 0.001)
  })

  it('does nothing when there is no movement', () => {
    const result = resolveMovement({ x: 250, y: 250, dx: 0, dy: 0, radius: RADIUS, colliders: wall, bounds: BOUNDS })
    expect(result).toEqual({ x: 250, y: 250, blockedX: false, blockedY: false })
  })
})

describe('isWalkable', () => {
  const colliders = [{ x: 100, y: 100, w: 100, h: 100 }]

  it('rejects a point inside solid geometry', () => {
    expect(isWalkable(150, 150, RADIUS, colliders, BOUNDS)).toBe(false)
  })

  it('rejects points outside the bounds', () => {
    expect(isWalkable(5, 500, RADIUS, colliders, BOUNDS)).toBe(false)
    expect(isWalkable(500, 998, RADIUS, colliders, BOUNDS)).toBe(false)
  })

  it('accepts free floor', () => {
    expect(isWalkable(500, 500, RADIUS, colliders, BOUNDS)).toBe(true)
  })
})
