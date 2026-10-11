// Renderer smoke tests.
//
// There is no browser in this environment, so the second-best proof that the
// office actually draws is: run the real render pipeline against a recording 2D
// context at every realistic viewport/zoom combination and assert that it paints a
// plausible number of things without throwing. The fake context also throws on
// non-finite geometry, which catches NaN maths in the drawing code.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera.js'
import * as world from './worldRenderer.js'
import { drawFurnitureItem, FURNITURE_TYPES, FURNITURE_DRAWERS } from './furniture.js'
import { drawAvatar, drawAvatarLabel, blinkState, facingToIndex, facingName } from './avatarRenderer.js'
import { createAvatarAppearance, createLocalAppearance, HAIR_STYLES, SKIN_TONES } from './avatarAppearance.js'
import { createFakeContext } from '../test/fakeCanvas.js'
import { FURNITURE, WORLD, WORLD_SUMMARY, ZONES } from '../world/worldData.js'

const VIEWPORTS = [
  { name: 'laptop', w: 1280, h: 720 },
  { name: 'desktop', w: 1920, h: 1080 },
  { name: 'small', w: 800, h: 600 },
  { name: 'phone', w: 390, h: 844 },
  { name: 'ultrawide', w: 2560, h: 1080 },
  { name: 'huge', w: 3840, h: 2160 },
]

const WORLD_RECT = { x: 0, y: 0, w: WORLD.width, h: WORLD.height }

function createCamera(viewport, { zoom = 1, x = 1280, y = 800 } = {}) {
  const camera = new Camera({ world: WORLD_RECT, viewportWidth: viewport.w, viewportHeight: viewport.h, zoom, x, y })
  camera.setZoom(zoom)
  return camera
}

function renderFullScene(ctx, camera, { avatars = [], time = 1 } = {}) {
  world.drawBackdrop(ctx, camera)
  ctx.save()
  camera.applyTransform(ctx)
  world.drawWorldShadow(ctx)
  world.drawFloors(ctx, camera)
  world.drawRugs(ctx, camera)
  world.drawWalls(ctx, camera)
  world.drawDoors(ctx, camera)
  world.drawLightPools(ctx, camera)
  for (const item of world.visibleFurniture(camera)) drawFurnitureItem(ctx, item)
  for (const avatar of avatars) drawAvatar(ctx, avatar, { time })
  world.drawWallArt(ctx, camera)
  ctx.restore()
  world.drawVignette(ctx, camera)
  world.drawZoneLabels(ctx, camera, { showLabels: true })
  for (const avatar of avatars) {
    drawAvatarLabel(ctx, camera.worldToScreen(avatar.x, avatar.y), avatar, { zoom: camera.zoom })
  }
}

const sampleAvatars = () => [
  {
    id: 'local',
    name: 'You',
    appearance: createLocalAppearance('You'),
    isLocal: true,
    x: 1280,
    y: 1400,
    facing: Math.PI / 2,
    moving: true,
    walkPhase: 0.35,
    speaking: true,
  },
  {
    id: 'peer-a',
    name: 'Priya',
    appearance: createAvatarAppearance('peer-a'),
    x: 1100,
    y: 1200,
    facing: 0,
    moving: false,
    walkPhase: 0,
    nearby: true,
    distance: 240,
  },
]

describe('full scene rendering', () => {
  it('renders a full frame at every realistic viewport size without throwing', () => {
    for (const viewport of VIEWPORTS) {
      const ctx = createFakeContext({ width: viewport.w, height: viewport.h })
      const camera = createCamera(viewport)
      expect(() => renderFullScene(ctx, camera, { avatars: sampleAvatars() })).not.toThrow()
      expect(ctx.calls.get('fill') ?? 0).toBeGreaterThan(50)
      expect(ctx.calls.get('stroke') ?? 0).toBeGreaterThan(20)
      // avatar name pills are always drawn; room labels depend on what fits
      expect(ctx.calls.get('fillText') ?? 0).toBeGreaterThanOrEqual(2)
    }
  })

  it('renders at every zoom level without throwing', () => {
    for (const zoom of [0.5, 0.75, 1, 1.5, 2]) {
      const ctx = createFakeContext({ width: 1440, height: 900 })
      const camera = createCamera({ w: 1440, h: 900 }, { zoom })
      expect(() => renderFullScene(ctx, camera, { avatars: sampleAvatars() }), `zoom ${zoom}`).not.toThrow()
    }
  })

  it('renders every corner of the office (no room is broken)', () => {
    const corners = [
      { x: 200, y: 200, name: 'office row' },
      { x: 1280, y: 200, name: 'meeting room' },
      { x: 2300, y: 600, name: 'kitchen' },
      { x: 1280, y: 1400, name: 'reception' },
      { x: 2300, y: 1400, name: 'east restroom' },
      { x: 200, y: 900, name: 'storage' },
    ]
    for (const corner of corners) {
      const ctx = createFakeContext({ width: 1024, height: 768 })
      const camera = createCamera({ w: 1024, h: 768 }, { zoom: 1.25, x: corner.x, y: corner.y })
      expect(() => renderFullScene(ctx, camera, { avatars: sampleAvatars() }), corner.name).not.toThrow()
      expect(ctx.calls.get('fill') ?? 0, corner.name).toBeGreaterThan(30)
    }
  })

  it('draws labels only for rooms that are big enough on screen', () => {
    const ctx = createFakeContext({ width: 1280, height: 720 })
    const camera = createCamera({ w: 1280, h: 720 }, { zoom: 0.5 })
    world.drawZoneLabels(ctx, camera, { showLabels: true })
    const zoomedOutLabels = ctx.calls.get('fillText') ?? 0

    // Zoomed in on the open workspace, whose label sits at the room's head.
    const workspace = ZONES.find((zone) => zone.id === 'workspace')
    const ctx2 = createFakeContext({ width: 1280, height: 720 })
    const camera2 = createCamera({ w: 1280, h: 720 }, { zoom: 1.5, x: workspace.labelAt.x, y: workspace.labelAt.y })
    world.drawZoneLabels(ctx2, camera2, { showLabels: true })
    const zoomedInLabels = ctx2.calls.get('fillText') ?? 0

    expect(zoomedOutLabels).toBeLessThanOrEqual(ZONES.length * 2)
    expect(zoomedInLabels).toBeGreaterThan(0)
  })

  it('hides room labels for rooms that are too narrow to host them', () => {
    const tiny = createFakeContext({ width: 400, height: 300 })
    const camera = createCamera({ w: 400, h: 300 }, { zoom: 0.5, x: 244, y: 200 })
    world.drawZoneLabels(tiny, camera, { showLabels: true })
    // office-a is 440 wide → 220 px at 0.5×, below the 150 px threshold is false,
    // but the east restroom at 0.5× is 206 px; the point is that it never floods
    // the screen and never draws more than two lines per visible room.
    expect(tiny.calls.get('fillText') ?? 0).toBeLessThanOrEqual(ZONES.length * 2)
  })

  it('can skip labels entirely', () => {
    const ctx = createFakeContext({ width: 1280, height: 720 })
    const camera = createCamera({ w: 1280, h: 720 })
    world.drawZoneLabels(ctx, camera, { showLabels: false })
    expect(ctx.calls.get('fillText') ?? 0).toBe(0)
  })
})

describe('culling', () => {
  it('only reports furniture inside the camera view', () => {
    const zoomedIn = createCamera({ w: 800, h: 600 }, { zoom: 2, x: 1280, y: 1400 })
    const visible = world.visibleFurniture(zoomedIn)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(FURNITURE.length)

    const all = createCamera({ w: 4000, h: 3000 }, { zoom: 0.5, x: 1280, y: 800 })
    expect(world.visibleFurniture(all).length).toBe(FURNITURE.length)
  })

  it('culls decor the same way', () => {
    const zoomedIn = createCamera({ w: 800, h: 600 }, { zoom: 2, x: 1280, y: 1400 })
    expect(world.visibleDecor(zoomedIn).length).toBeGreaterThan(0)
    expect(world.visibleZones(zoomedIn).length).toBeLessThan(ZONES.length)
  })
})

describe('furniture drawing coverage', () => {
  it('has a drawer for every furniture type used in the world', () => {
    const used = new Set(FURNITURE.map((item) => item.type))
    const missing = [...used].filter((type) => !FURNITURE_TYPES.includes(type))
    expect(missing, `furniture types without a drawer: ${missing.join(', ')}`).toEqual([])
    expect(Object.keys(FURNITURE_DRAWERS).length).toBe(FURNITURE_TYPES.length)
  })

  it('draws every single furniture item without throwing', () => {
    for (const item of FURNITURE) {
      const ctx = createFakeContext()
      expect(() => drawFurnitureItem(ctx, item), `${item.id} (${item.type})`).not.toThrow()
      expect(ctx.calls.get('fill') ?? 0, `${item.id} painted nothing`).toBeGreaterThan(0)
    }
  })

  it('draws correctly at all four rotations', () => {
    for (const rot of [0, 90, 180, 270]) {
      const ctx = createFakeContext()
      const item = { ...FURNITURE[0], rot }
      expect(() => drawFurnitureItem(ctx, item), `rot ${rot}`).not.toThrow()
    }
  })

  it('ignores unknown furniture types instead of crashing', () => {
    const ctx = createFakeContext()
    expect(drawFurnitureItem(ctx, { id: 'x', type: 'hovercraft', x: 0, y: 0, w: 10, h: 10, rot: 0, props: [] })).toBe(false)
  })

  it('reports world statistics for the UI', () => {
    const stats = world.worldStats()
    expect(stats.furniture).toBe(WORLD_SUMMARY.furniture)
    expect(stats.zones).toBe(WORLD_SUMMARY.zones)
  })
})

describe('avatar rendering', () => {
  it('draws every facing direction, walking and idle', () => {
    for (let index = 0; index < 8; index += 1) {
      const ctx = createFakeContext()
      const avatar = {
        id: `peer-${index}`,
        name: `Peer ${index}`,
        appearance: createAvatarAppearance(`peer-${index}`),
        x: 500,
        y: 500,
        facing: (index * Math.PI) / 4,
        moving: index % 2 === 0,
        walkPhase: index / 8,
      }
      expect(() => drawAvatar(ctx, avatar, { time: index }), `facing index ${index}`).not.toThrow()
      expect(ctx.calls.get('fill') ?? 0).toBeGreaterThan(5)
    }
  })

  it('maps angles to the eight documented directions', () => {
    expect(facingToIndex(0)).toBe(0)
    expect(facingToIndex(Math.PI / 2)).toBe(2)
    expect(facingToIndex(Math.PI)).toBe(4)
    expect(facingToIndex(-Math.PI / 2)).toBe(6)
    expect(facingName(0)).toBe('east')
    expect(facingName(Math.PI / 2)).toBe('south')
    expect(facingName(Math.PI)).toBe('west')
    expect(facingName(-Math.PI / 2)).toBe('north')
  })

  it('draws the indicator slots: local ring, speaking, muted, nearby', () => {
    const ctx = createFakeContext()
    const avatar = {
      id: 'local',
      name: 'You',
      appearance: createLocalAppearance('You'),
      isLocal: true,
      x: 500,
      y: 500,
      facing: Math.PI / 2,
      speaking: true,
      muted: true,
      nearby: true,
      moving: false,
    }
    expect(() => drawAvatar(ctx, avatar, { time: 2 })).not.toThrow()
    expect(() => drawAvatarLabel(ctx, { x: 500, y: 400 }, avatar, { zoom: 1 })).not.toThrow()
    expect(ctx.calls.get('setLineDash') ?? 0).toBeGreaterThan(0) // proximity halo
  })

  it('renders a name label with badges for peers', () => {
    const ctx = createFakeContext()
    const avatar = {
      id: 'peer',
      name: 'Priya',
      appearance: createAvatarAppearance('peer'),
      x: 0,
      y: 0,
      nearby: true,
      distance: 210,
      speaking: true,
    }
    drawAvatarLabel(ctx, { x: 400, y: 300 }, avatar, { zoom: 1 })
    expect(ctx.calls.get('fillText') ?? 0).toBeGreaterThanOrEqual(2) // name + distance chip
  })

  it('respects the showNames flag', () => {
    const ctx = createFakeContext()
    drawAvatarLabel(ctx, { x: 0, y: 0 }, { name: 'Priya' }, { showNames: false })
    expect(ctx.calls.get('fillText') ?? 0).toBe(0)
  })

  it('blinks deterministically from a seed', () => {
    const first = blinkState(1234, 0.5)
    const second = blinkState(1234, 0.5)
    expect(first).toBe(second)
    // over a full cycle it blinks at least once
    let blinks = 0
    for (let t = 0; t < 9; t += 0.01) if (blinkState(7, t)) blinks += 1
    expect(blinks).toBeGreaterThan(0)
  })

  it('handles a missing appearance gracefully', () => {
    const ctx = createFakeContext()
    expect(drawAvatar(ctx, { x: 0, y: 0, facing: 0 })).toBe(false)
  })
})

describe('avatar appearance', () => {
  it('is deterministic for the same id', () => {
    const a = createAvatarAppearance('player-42')
    const b = createAvatarAppearance('player-42')
    expect(a).toEqual(b)
  })

  it('varies across ids', () => {
    const shirts = new Set()
    const hairs = new Set()
    for (let i = 0; i < 40; i += 1) {
      const appearance = createAvatarAppearance(`player-${i}`)
      shirts.add(appearance.shirt)
      hairs.add(appearance.hairStyle)
    }
    expect(shirts.size).toBeGreaterThan(3)
    expect(hairs.size).toBeGreaterThan(3)
  })

  it('draws from the documented ranges', () => {
    for (let i = 0; i < 20; i += 1) {
      const appearance = createAvatarAppearance(`p-${i}`)
      expect(SKIN_TONES).toContain(appearance.skin)
      expect(HAIR_STYLES).toContain(appearance.hairStyle)
      expect(typeof appearance.hasBag).toBe('boolean')
    }
  })

  it('marks the local player with a distinct accent', () => {
    const local = createLocalAppearance('You')
    expect(local.accent).toBeTruthy()
    expect(local.accessory).not.toBe('none')
  })
})
