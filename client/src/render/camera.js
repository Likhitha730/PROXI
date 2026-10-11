// Camera: world ⇄ screen transform, follow behaviour, clamping and smooth zoom.
//
// Pure logic (no canvas, no DOM) so it is unit-testable. The renderer only ever
// reads `x`, `y` and `zoom`.
//
// Rules baked in here:
//   - the visible world rect never extends past the world bounds, unless the world
//     is smaller than the viewport at the current zoom (then it is centred and the
//     renderer letterboxes the remainder)
//   - zoom is clamped to [minZoom, maxZoom] and eased toward its target with
//     frame-rate independent damping
//   - zoom-to-cursor keeps the world point under the pointer fixed while easing
//   - "follow" mode tracks a target; manual panning simply turns it off

import { clamp, damp } from './../world/math.js'

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2

export class Camera {
  constructor(options = {}) {
    this.world = options.world ?? { x: 0, y: 0, w: 2560, h: 1600 }
    this.x = options.x ?? this.world.x + this.world.w / 2
    this.y = options.y ?? this.world.y + this.world.h / 2
    this.zoom = clamp(options.zoom ?? 1, MIN_ZOOM, MAX_ZOOM)
    this.targetZoom = this.zoom
    this.viewport = { w: options.viewportWidth ?? 1280, h: options.viewportHeight ?? 720 }
    this.follow = options.follow ?? true
    this.followTarget = null // { x, y }
    this.zoomAnchor = null // { world: {x,y}, screen: {x,y} }
    this.followLambda = options.followLambda ?? 9
    this.zoomLambda = options.zoomLambda ?? 12
  }

  // ------------------------------------------------------------- viewport ---

  setViewport(width, height) {
    this.viewport.w = Math.max(1, width)
    this.viewport.h = Math.max(1, height)
    this.clampToWorld()
  }

  setWorldBounds(bounds) {
    this.world = bounds
    this.clampToWorld()
  }

  // ----------------------------------------------------------------- zoom ---

  /** Set the zoom target, optionally keeping a screen point pinned to a world point. */
  setZoomTarget(zoom, anchorScreen = null) {
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
    if (anchorScreen) {
      const worldPoint = this.screenToWorld(anchorScreen.x, anchorScreen.y)
      this.zoomAnchor = { world: worldPoint, screen: { x: anchorScreen.x, y: anchorScreen.y } }
    } else if (Math.abs(next - this.targetZoom) > 1e-4) {
      this.zoomAnchor = null
    }
    this.targetZoom = next
    return this.targetZoom
  }

  zoomBy(factor, anchorScreen = null) {
    return this.setZoomTarget(this.targetZoom * factor, anchorScreen)
  }

  /** Immediate zoom (tests, reset). */
  setZoom(zoom, { anchorScreen = null } = {}) {
    this.setZoomTarget(zoom, anchorScreen)
    this.zoom = this.targetZoom
    this.applyZoomAnchor()
    this.clampToWorld()
    return this.zoom
  }

  get zoomRatio() {
    return (this.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)
  }

  // ------------------------------------------------------------ follow -----

  followPlayer(target) {
    this.followTarget = target
    this.follow = true
    this.zoomAnchor = null
  }

  setFollow(enabled) {
    this.follow = enabled
    return this.follow
  }

  /** Manual pan by a screen-space delta (used by pointer dragging). */
  panBy(deltaScreenX, deltaScreenY) {
    this.follow = false
    this.x -= deltaScreenX / this.zoom
    this.y -= deltaScreenY / this.zoom
    this.clampToWorld()
  }

  centerOn(x, y) {
    this.x = x
    this.y = y
    this.clampToWorld()
  }

  /** Reset to a known-good view: follow on, zoom 1, centred on the target. */
  reset(target = null) {
    this.targetZoom = 1
    this.zoom = 1
    this.zoomAnchor = null
    if (target) {
      this.followTarget = target
      this.follow = true
      this.centerOn(target.x, target.y)
    } else {
      this.follow = true
      this.centerOn(this.followTarget?.x ?? this.world.x + this.world.w / 2, this.followTarget?.y ?? this.world.y + this.world.h / 2)
    }
    return this
  }

  // ------------------------------------------------------------- update ----

  update(dt) {
    if (this.follow && this.followTarget) {
      this.x = damp(this.x, this.followTarget.x, this.followLambda, dt)
      this.y = damp(this.y, this.followTarget.y, this.followLambda, dt)
    }

    if (Math.abs(this.targetZoom - this.zoom) > 1e-4) {
      this.zoom = damp(this.zoom, this.targetZoom, this.zoomLambda, dt)
      if (Math.abs(this.targetZoom - this.zoom) < 1e-3) this.zoom = this.targetZoom
      if (this.zoomAnchor) this.applyZoomAnchor()
    }

    this.clampToWorld()
    return this
  }

  applyZoomAnchor() {
    if (!this.zoomAnchor) return
    const { world, screen } = this.zoomAnchor
    // Where is the anchored world point on screen right now?
    const current = this.worldToScreen(world.x, world.y)
    const dx = current.x - screen.x
    const dy = current.y - screen.y
    this.x += dx / this.zoom
    this.y += dy / this.zoom
    this.clampToWorld()
  }

  clearZoomAnchor() {
    this.zoomAnchor = null
  }

  // ------------------------------------------------------------ clamping ---

  get halfView() {
    return { w: this.viewport.w / (2 * this.zoom), h: this.viewport.h / (2 * this.zoom) }
  }

  clampToWorld() {
    const { w: halfW, h: halfH } = this.halfView
    const { x, y, w, h } = this.world

    // A viewport wider than the world cannot be clamped — centre and letterbox.
    this.x = w <= halfW * 2 ? x + w / 2 : clamp(this.x, x + halfW, x + w - halfW)
    this.y = h <= halfH * 2 ? y + h / 2 : clamp(this.y, y + halfH, y + h - halfH)
    return this
  }

  /** The world-space rectangle currently visible (may exceed the world when letterboxed). */
  visibleWorldRect() {
    const { w: halfW, h: halfH } = this.halfView
    return { x: this.x - halfW, y: this.y - halfH, w: halfW * 2, h: halfH * 2 }
  }

  // ---------------------------------------------------------- transforms ---

  worldToScreen(worldX, worldY) {
    return {
      x: (worldX - this.x) * this.zoom + this.viewport.w / 2,
      y: (worldY - this.y) * this.zoom + this.viewport.h / 2,
    }
  }

  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.viewport.w / 2) / this.zoom + this.x,
      y: (screenY - this.viewport.h / 2) / this.zoom + this.y,
    }
  }

  /** Apply the camera transform to a 2D context (CSS-pixel coordinate space). */
  applyTransform(ctx) {
    ctx.translate(this.viewport.w / 2, this.viewport.h / 2)
    ctx.scale(this.zoom, this.zoom)
    ctx.translate(-this.x, -this.y)
  }

  /** Describes the camera for the HUD. */
  describe() {
    return {
      x: Math.round(this.x),
      y: Math.round(this.y),
      zoom: Number(this.zoom.toFixed(2)),
      follow: this.follow,
    }
  }
}
