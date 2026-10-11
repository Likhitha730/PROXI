// Layout integrity tests — these guard the office geometry itself.
//
// They are the automated version of the "is anything clipped or floating outside
// the building?" review, and they run on every `npm test`.

import { describe, expect, it } from 'vitest'
import {
  AVATAR_RADIUS,
  DECOR,
  DOORS,
  FURNITURE,
  SPAWNS,
  STATIC_COLLIDERS,
  WALKABLE_BOUNDS,
  WALLS,
  WORLD,
  WORLD_SUMMARY,
  ZONES,
  ZONE_BY_ID,
  COLLIDER_GRID,
  furnitureColliders,
} from './worldData.js'
import { circleHitsAny, isWalkable } from './collision.js'

const rectOf = (item) => ({ x: item.x - item.w / 2, y: item.y - item.h / 2, w: item.w, h: item.h })
const inside = (inner, outer, slack = 0) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.w <= outer.x + outer.w + slack &&
  inner.y + inner.h <= outer.y + outer.h + slack

/** Walls sit on room borders, so furniture must stay a wall-thickness away. */
const WALL_CLEARANCE = 24

/** Half of the thickest wall plus a margin — used to probe either side of a door. */
const WALL_THICKNESS_CLEARANCE = 10

describe('world geometry', () => {
  it('defines the documented logical world size', () => {
    expect(WORLD.width).toBe(2560)
    expect(WORLD.height).toBe(1600)
    expect(WALKABLE_BOUNDS.w).toBeGreaterThan(WORLD.width - 100)
  })

  it('covers every room the requirements ask for', () => {
    const names = ZONES.map((z) => z.id)
    for (const required of [
      'reception',
      'workspace',
      'office-a',
      'office-b',
      'office-c',
      'meeting',
      'lounge',
      'kitchen',
      'huddle',
      'restroom-w',
      'restroom-e',
    ]) {
      expect(names, `missing zone ${required}`).toContain(required)
    }
  })

  it('keeps every room inside the building and non-overlapping', () => {
    const shell = { x: WORLD.margin, y: WORLD.margin, w: WORLD.width - WORLD.margin * 2, h: WORLD.height - WORLD.margin * 2 }
    for (const zone of ZONES) {
      expect(inside(zone, shell), `${zone.id} escapes the exterior shell`).toBe(true)
      expect(zone.w).toBeGreaterThan(120)
      expect(zone.h).toBeGreaterThan(120)
    }

    // Rooms may share a wall line but must not overlap by more than a thickness.
    for (let i = 0; i < ZONES.length; i += 1) {
      for (let j = i + 1; j < ZONES.length; j += 1) {
        const a = ZONES[i]
        const b = ZONES[j]
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        const area = Math.max(0, overlapX) * Math.max(0, overlapY)
        // two rooms touching along a shared edge have zero area overlap
        expect(area, `${a.id} overlaps ${b.id}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('puts the open workspace in the middle and restrooms in the bottom corners', () => {
    const workspace = ZONE_BY_ID.workspace
    expect(workspace.x).toBeLessThan(1280)
    expect(workspace.x + workspace.w).toBeGreaterThan(1280)

    const restroomW = ZONE_BY_ID['restroom-w']
    const restroomE = ZONE_BY_ID['restroom-e']
    expect(restroomW.y).toBeGreaterThan(WORLD.height / 2)
    expect(restroomE.y).toBeGreaterThan(WORLD.height / 2)
    expect(restroomW.x).toBeLessThan(WORLD.width / 2)
    expect(restroomE.x).toBeGreaterThan(WORLD.width / 2)

    // kitchen + huddle room on the right, meeting room + lounge at the top
    expect(ZONE_BY_ID.kitchen.x).toBeGreaterThan(WORLD.width / 2)
    expect(ZONE_BY_ID.huddle.x).toBeGreaterThan(WORLD.width / 2)
    expect(ZONE_BY_ID.meeting.y).toBeLessThan(WORLD.height / 4)
    expect(ZONE_BY_ID.lounge.y).toBeLessThan(WORLD.height / 4)
  })
})

describe('furniture placement', () => {
  it('never clips furniture against a wall', () => {
    const failures = []
    for (const item of FURNITURE) {
      const rect = rectOf(item)
      const home = ZONES.find((zone) =>
        inside(rect, { x: zone.x + WALL_CLEARANCE, y: zone.y + WALL_CLEARANCE, w: zone.w - WALL_CLEARANCE * 2, h: zone.h - WALL_CLEARANCE * 2 }),
      )
      if (!home) failures.push(`${item.id} (${item.type}) at ${item.x},${item.y}`)
    }
    expect(failures, `furniture outside the safe interior of every room:\n${failures.join('\n')}`).toEqual([])
  })

  it('keeps every footprint inside the walkable world', () => {
    for (const item of FURNITURE) {
      const rect = rectOf(item)
      expect(inside(rect, WALKABLE_BOUNDS), `${item.id} leaves the walkable area`).toBe(true)
    }
  })

  it('sizes every item sensibly', () => {
    for (const item of FURNITURE) {
      expect(item.w, `${item.id} width`).toBeGreaterThan(20)
      expect(item.h, `${item.id} height`).toBeGreaterThan(20)
      expect(item.w, `${item.id} width`).toBeLessThanOrEqual(460)
      expect(item.h, `${item.id} height`).toBeLessThanOrEqual(460)
    }
  })

  it('points every chair at the furniture it is pulled up to', () => {
    // A chair is only believable if the occupant faces the desk/table it belongs
    // to, and — when that furniture has a screen — sits on the near side of it
    // rather than behind the monitor. Regression guard for a real bug where a
    // whole row of desk chairs faced the wrong way.
    const seats = FURNITURE.filter((f) =>
      ['desk', 'receptionDesk', 'boardroomTable', 'collabTable', 'cafeTable', 'coffeeTable'].includes(f.type),
    )
    // Which local side of the furniture the occupant sits on (local +y is "down").
    //   desk          -> monitor on the far (-y) edge, so the user sits at +y
    //   receptionDesk -> branded visitor panel at +y, receptionist behind it at -y
    const occupantSide = { desk: 1, receptionDesk: -1 }
    const offset = (degrees, localX, localY) => {
      const radians = (degrees * Math.PI) / 180
      return {
        x: localX * Math.cos(radians) - localY * Math.sin(radians),
        y: localX * Math.sin(radians) + localY * Math.cos(radians),
      }
    }

    const chairs = FURNITURE.filter((f) => f.type === 'chair')
    expect(chairs.length).toBeGreaterThan(20)

    for (const chair of chairs) {
      const nearest = seats
        .map((seat) => ({ seat, distance: Math.hypot(seat.x - chair.x, seat.y - chair.y) }))
        .sort((a, b) => a.distance - b.distance)[0].seat
      const where = `chair@${chair.x},${chair.y} vs ${nearest.type}@${nearest.x},${nearest.y}`

      // backrest sits at the chair's local +y, so the seat looks the opposite way
      const backrest = offset(chair.rot, 0, 1)
      const looking = { x: -backrest.x, y: -backrest.y }
      const towards = { x: nearest.x - chair.x, y: nearest.y - chair.y }
      const distance = Math.hypot(towards.x, towards.y) || 1
      const facing = (looking.x * towards.x + looking.y * towards.y) / distance
      expect(facing, `${where} does not face its furniture`).toBeGreaterThan(0.5)

      const side = occupantSide[nearest.type]
      if (!side) continue
      const occupant = offset(nearest.rot, 0, (side * nearest.h) / 2)
      const chairSide = { x: chair.x - nearest.x, y: chair.y - nearest.y }
      const sameSide = chairSide.x * occupant.x + chairSide.y * occupant.y
      expect(sameSide, `${where} sits on the far side of the desk (behind the monitor)`).toBeGreaterThan(0)
    }
  })

  it('furnishes every room with something', () => {
    const empty = ZONES.filter(
      (zone) => !FURNITURE.some((item) => inside(rectOf(item), zone)),
    ).map((zone) => zone.id)
    expect(empty).toEqual([])
  })

  it('provides the required furniture variety', () => {
    const types = new Set(FURNITURE.map((item) => item.type))
    for (const required of ['desk', 'chair', 'plant', 'sofa', 'counter', 'fridge', 'stall', 'receptionDesk', 'boardroomTable']) {
      expect([...types], `missing furniture type ${required}`).toContain(required)
    }
    // "multiple desks" in the open workspace
    const desksInWorkspace = FURNITURE.filter(
      (item) => item.type === 'desk' && inside(rectOf(item), ZONE_BY_ID.workspace),
    )
    expect(desksInWorkspace.length).toBeGreaterThanOrEqual(6)
  })
})

describe('collision geometry', () => {
  it('builds one collider per wall and solid furniture item', () => {
    expect(STATIC_COLLIDERS.length).toBe(WALLS.length + furnitureColliders().length)
    expect(WORLD_SUMMARY.colliders).toBe(STATIC_COLLIDERS.length)
    expect(STATIC_COLLIDERS.length).toBeGreaterThan(100)
  })

  it('keeps every doorway wide enough for the avatar', () => {
    for (const door of DOORS) {
      expect(door.width, `${door.id} too narrow`).toBeGreaterThan(AVATAR_RADIUS * 2 + 30)
    }
  })

  it('leaves every doorway passable for an avatar', () => {
    // A door centre sits *on* a wall line, so the meaningful checks are:
    //   1. no collider overlaps the opening itself, and
    //   2. the floor just inside the opening is walkable (both faces for interior
    //      doors; the inner face only for the exterior entrance).
    const failures = []
    for (const door of DOORS) {
      const vertical = door.orientation === 'vertical'
      const clearance = WALL_THICKNESS_CLEARANCE + AVATAR_RADIUS
      const probes = vertical
        ? [
            { x: door.x - clearance, y: door.y },
            { x: door.x + clearance, y: door.y },
          ]
        : [
            { x: door.x, y: door.y - clearance },
            { x: door.x, y: door.y + clearance },
          ]

      const centre = { x: door.x, y: door.y }
      const openingBlocked = circleHitsAny(centre.x, centre.y, AVATAR_RADIUS * 0.5, STATIC_COLLIDERS) !== null
      const walkableSides = probes.filter((probe) =>
        isWalkable(probe.x, probe.y, AVATAR_RADIUS, STATIC_COLLIDERS, WALKABLE_BOUNDS),
      ).length

      const requiredSides = door.exterior ? 1 : 2
      if (openingBlocked || walkableSides < requiredSides) {
        failures.push(`${door.id} (blocked=${openingBlocked}, walkableSides=${walkableSides}/${requiredSides})`)
      }
    }
    expect(failures, `blocked doorways:\n${failures.join('\n')}`).toEqual([])
  })

  it('keeps every spawn point walkable', () => {
    for (const spawn of SPAWNS) {
      expect(
        isWalkable(spawn.x, spawn.y, AVATAR_RADIUS, STATIC_COLLIDERS, WALKABLE_BOUNDS),
        `spawn ${spawn.id} is inside solid geometry`,
      ).toBe(true)
    }
  })

  it('indexes colliders in the spatial grid for fast lookups', () => {
    expect(COLLIDER_GRID.size).toBe(STATIC_COLLIDERS.length)
    const nearEntrance = COLLIDER_GRID.query({ x: 1200, y: 1450, w: 160, h: 160 })
    expect(nearEntrance.length).toBeGreaterThan(0)
    expect(nearEntrance.length).toBeLessThan(STATIC_COLLIDERS.length)
    const farAway = COLLIDER_GRID.query({ x: -5000, y: -5000, w: 10, h: 10 })
    expect(farAway).toEqual([])
  })
})

describe('decor', () => {
  it('keeps decor overlays inside the building', () => {
    const shell = { x: WORLD.margin, y: WORLD.margin, w: WORLD.width - WORLD.margin * 2, h: WORLD.height - WORLD.margin * 2 }
    for (const overlay of DECOR) {
      expect(inside(rectOf(overlay), shell), `${overlay.id} escapes the shell`).toBe(true)
    }
  })

  it('includes rugs, lighting and wall art without adding colliders', () => {
    const types = new Set(DECOR.map((d) => d.type))
    expect([...types]).toEqual(expect.arrayContaining(['rug', 'lightPool', 'whiteboard', 'artFrame']))
    const furnitureColliderCount = furnitureColliders().length
    expect(STATIC_COLLIDERS.length).toBe(WALLS.length + furnitureColliderCount)
  })
})
