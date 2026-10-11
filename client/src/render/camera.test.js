// Camera behaviour + viewport QA.
//
// The viewport matrix below is the automated version of "test the complete office
// layout at different viewport sizes": for every common screen size and every zoom
// level, the camera must never leak outside the world, and when the world is
// smaller than the viewport it must be centred (the renderer letterboxes it).

import { describe, expect, it } from 'vitest'
import { Camera, MAX_ZOOM, MIN_ZOOM } from './camera.js'
import { WORLD } from '../world/worldData.js'

const WORLD_RECT = { x: 0, y: 0, w: WORLD.width, h: WORLD.height }

const VIEWPORTS = [
  { name: 'laptop 1280×720', w: 1280, h: 720 },
  { name: 'desktop 1920×1080', w: 1920, h: 1080 },
  { name: 'small 800×600', w: 800, h: 600 },
  { name: 'phone 390×844', w: 390, h: 844 },
  { name: 'ultrawide 2560×1080', w: 2560, h: 1080 },
  { name: 'huge 3840×2160', w: 3840, h: 2160 },
  { name: 'tiny 320×240', w: 320, h: 240 },
]

const createCamera = (viewport, options = {}) =>
  new Camera({ world: WORLD_RECT, viewportWidth: viewport.w, viewportHeight: viewport.h, ...options })

describe('camera transforms', () => {
  it('round-trips world → screen → world', () => {
    const camera = createCamera({ w: 1280, h: 720 }, { zoom: 0.8, x: 900, y: 700 })
    for (const point of [
      { x: 0, y: 0 },
      { x: 2560, y: 1600 },
      { x: 1240, y: 830 },
    ]) {
      const screen = camera.worldToScreen(point.x, point.y)
      const back = camera.screenToWorld(screen.x, screen.y)
      expect(back.x).toBeCloseTo(point.x, 6)
      expect(back.y).toBeCloseTo(point.y, 6)
    }
  })

  it('centres the view on the camera position', () => {
    const camera = createCamera({ w: 1000, h: 600 }, { zoom: 1, x: 500, y: 500 })
    const centre = camera.worldToScreen(500, 500)
    expect(centre).toEqual({ x: 500, y: 300 })
  })

  it('scales distances by the zoom level', () => {
    const camera = createCamera({ w: 1000, h: 600 }, { zoom: 2, x: 500, y: 300 })
    const right = camera.worldToScreen(510, 300)
    expect(right.x - 500).toBe(20) // 10 world units at zoom 2
  })
})

describe('zoom', () => {
  it('clamps the zoom target to the documented range', () => {
    const camera = createCamera({ w: 1000, h: 600 })
    camera.setZoomTarget(10)
    expect(camera.targetZoom).toBe(MAX_ZOOM)
    camera.setZoomTarget(0.01)
    expect(camera.targetZoom).toBe(MIN_ZOOM)
    expect(MIN_ZOOM).toBe(0.5)
    expect(MAX_ZOOM).toBe(2)
  })

  it('eases toward the target over several frames instead of snapping', () => {
    const camera = createCamera({ w: 1000, h: 600 })
    camera.setZoomTarget(2)
    camera.update(1 / 60)
    expect(camera.zoom).toBeGreaterThan(1)
    expect(camera.zoom).toBeLessThan(2)
    for (let i = 0; i < 120; i += 1) camera.update(1 / 60)
    expect(camera.zoom).toBeCloseTo(2, 3)
  })

  it('keeps the world point under the cursor pinned while zooming (zoom-to-cursor)', () => {
    const camera = createCamera({ w: 1200, h: 800 })
    const anchor = { x: 900, y: 250 }
    const worldBefore = camera.screenToWorld(anchor.x, anchor.y)

    camera.zoomBy(1.8, anchor)
    for (let i = 0; i < 120; i += 1) camera.update(1 / 60)

    const worldAfter = camera.screenToWorld(anchor.x, anchor.y)
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 0)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 0)
  })
})

describe('follow behaviour', () => {
  it('moves toward the target smoothly and settles on it', () => {
    const camera = createCamera({ w: 1280, h: 720 })
    const target = { x: 1400, y: 900 }
    camera.centerOn(1000, 800)
    camera.followPlayer(target)

    camera.update(1 / 60)
    expect(camera.x).toBeGreaterThan(1000)
    expect(camera.x).toBeLessThan(1400)

    for (let i = 0; i < 200; i += 1) camera.update(1 / 60)
    expect(camera.x).toBeCloseTo(1400, 0)
    expect(camera.y).toBeCloseTo(900, 0)
  })

  it('turns follow off when the user drags the camera', () => {
    const camera = createCamera({ w: 1000, h: 600 })
    camera.followPlayer({ x: 1200, y: 800 })
    expect(camera.follow).toBe(true)

    camera.panBy(-120, -60)
    expect(camera.follow).toBe(false)
    // panning moves the view opposite to the drag direction
    expect(camera.x).toBeGreaterThan(1200)
  })

  it('reset() restores zoom 1, follow on, and centres on the target', () => {
    const camera = createCamera({ w: 1000, h: 600 })
    camera.setZoom(1.9)
    camera.panBy(300, 300)
    const target = { x: 700, y: 1200 }
    camera.reset(target)
    expect(camera.zoom).toBe(1)
    expect(camera.targetZoom).toBe(1)
    expect(camera.follow).toBe(true)
    expect(camera.x).toBeCloseTo(700, 6)
    expect(camera.y).toBeCloseTo(1200, 6)
  })
})

describe('clamping — the view never leaves the world', () => {
  it('keeps the visible rect inside the world for every viewport at zoom 1', () => {
    for (const viewport of VIEWPORTS) {
      const camera = createCamera(viewport)
      for (const position of [
        { x: 0, y: 0 },
        { x: WORLD.width, y: WORLD.height },
        { x: 1280, y: 800 },
      ]) {
        camera.centerOn(position.x, position.y)
        const view = camera.visibleWorldRect()
        const fitsHorizontally = view.w > WORLD.width
        const fitsVertically = view.h > WORLD.height
        if (!fitsHorizontally) {
          expect(view.x, `${viewport.name} left edge`).toBeGreaterThanOrEqual(WORLD_RECT.x - 0.001)
          expect(view.x + view.w, `${viewport.name} right edge`).toBeLessThanOrEqual(WORLD_RECT.x + WORLD.width + 0.001)
        } else {
          // world narrower than the viewport → centred (letterboxed)
          expect(camera.x).toBeCloseTo(WORLD.width / 2, 6)
        }
        if (!fitsVertically) {
          expect(view.y, `${viewport.name} top edge`).toBeGreaterThanOrEqual(WORLD_RECT.y - 0.001)
          expect(view.y + view.h, `${viewport.name} bottom edge`).toBeLessThanOrEqual(WORLD_RECT.y + WORLD.height + 0.001)
        } else {
          expect(camera.y).toBeCloseTo(WORLD.height / 2, 6)
        }
      }
    }
  })

  it('keeps the visible rect inside the world at every zoom level', () => {
    for (const viewport of VIEWPORTS) {
      for (const zoom of [MIN_ZOOM, 0.75, 1, 1.5, MAX_ZOOM]) {
        const camera = createCamera(viewport)
        camera.setZoom(zoom)
        camera.centerOn(200, 300)
        const view = camera.visibleWorldRect()
        if (view.w <= WORLD.width) {
          expect(view.x, `${viewport.name} @${zoom}x`).toBeGreaterThanOrEqual(-0.001)
          expect(view.x + view.w, `${viewport.name} @${zoom}x`).toBeLessThanOrEqual(WORLD.width + 0.001)
        }
        if (view.h <= WORLD.height) {
          expect(view.y, `${viewport.name} @${zoom}x`).toBeGreaterThanOrEqual(-0.001)
          expect(view.y + view.h, `${viewport.name} @${zoom}x`).toBeLessThanOrEqual(WORLD.height + 0.001)
        }
      }
    }
  })

  it('centres the world when it is smaller than the viewport (letterbox case)', () => {
    const camera = createCamera({ w: 4000, h: 3000 })
    camera.centerOn(100, 100)
    expect(camera.x).toBeCloseTo(WORLD.width / 2, 6)
    expect(camera.y).toBeCloseTo(WORLD.height / 2, 6)
    expect(camera.visibleWorldRect().w).toBeGreaterThan(WORLD.width)
  })

  it('resizes the viewport without leaving the world', () => {
    const camera = createCamera({ w: 1920, h: 1080 })
    camera.centerOn(WORLD.width, WORLD.height)
    camera.setViewport(600, 400)
    const view = camera.visibleWorldRect()
    expect(view.x + view.w).toBeLessThanOrEqual(WORLD.width + 0.001)
    expect(view.y + view.h).toBeLessThanOrEqual(WORLD.height + 0.001)
  })

  it('reports its state for the HUD', () => {
    const camera = createCamera({ w: 1280, h: 720 }, { zoom: 1.25, x: 512.4, y: 300.6 })
    expect(camera.describe()).toEqual({ x: 512, y: 301, zoom: 1.25, follow: true })
  })
})
