// World renderer: everything that is *not* an avatar.
//
// Drawing only — no input, no state, no network. The engine decides what to draw
// and in which order; this module owns how the office looks.
//
// Per-frame culling uses the spatial grids from worldData, so a zoomed-in view
// only pays for the furniture and decor actually on screen.

import {
  DECOR_GRID,
  DOORS,
  FURNITURE,
  FURNITURE_GRID,
  WALLS,
  WORLD,
  ZONES,
  ZONE_BY_ID,
} from '../world/worldData.js'
import { PALETTE, floorPalette, shade, withAlpha } from './palette.js'
import { body, ellipse, roundRectPath } from './furniture.js'

const LABEL_FONT = "600 12px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const SUBLABEL_FONT = "500 10px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

const rectOf = (item) => ({ x: item.x - item.w / 2, y: item.y - item.h / 2, w: item.w, h: item.h })

/** Furniture items intersecting the camera view (deduplicated). */
export function visibleFurniture(camera) {
  return FURNITURE_GRID.queryUnique(camera.visibleWorldRect()).map((entry) => entry.item)
}

/** Decor overlays intersecting the camera view (deduplicated). */
export function visibleDecor(camera) {
  return DECOR_GRID.queryUnique(camera.visibleWorldRect()).map((entry) => entry.item)
}

export function visibleZones(camera) {
  const view = camera.visibleWorldRect()
  return ZONES.filter(
    (zone) =>
      zone.x < view.x + view.w && zone.x + zone.w > view.x && zone.y < view.y + view.h && zone.y + zone.h > view.y,
  )
}

// ------------------------------------------------------------- backdrop -----

/** Letterbox field around the building, drawn before the world. */
export function drawBackdrop(ctx, camera) {
  const { w, h } = camera.viewport
  ctx.fillStyle = PALETTE.backdrop
  ctx.fillRect(0, 0, w, h)

  // faint blueprint grid so the empty space still reads as "designed"
  const cell = 48 * camera.zoom
  if (cell > 10) {
    ctx.save()
    ctx.strokeStyle = PALETTE.backdropTile
    ctx.lineWidth = 1
    const offsetX = (-camera.x * camera.zoom + w / 2) % cell
    const offsetY = (-camera.y * camera.zoom + h / 2) % cell
    ctx.beginPath()
    for (let x = offsetX; x < w; x += cell) {
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, h)
    }
    for (let y = offsetY; y < h; y += cell) {
      ctx.moveTo(0, Math.round(y) + 0.5)
      ctx.lineTo(w, Math.round(y) + 0.5)
    }
    ctx.stroke()
    ctx.restore()
  }
}

/** Soft drop shadow under the building outline. */
export function drawWorldShadow(ctx) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = 32
  ctx.shadowOffsetY = 10
  ctx.fillStyle = '#0d121b'
  ctx.fillRect(WORLD.margin, WORLD.margin, WORLD.width - WORLD.margin * 2, WORLD.height - WORLD.margin * 2)
  ctx.restore()
}

// --------------------------------------------------------------- floors -----

function drawPlankPattern(ctx, zone, view) {
  const palette = floorPalette(zone.floor)
  const x0 = Math.max(zone.x, view.x)
  const y0 = Math.max(zone.y, view.y)
  const x1 = Math.min(zone.x + zone.w, view.x + view.w)
  const y1 = Math.min(zone.y + zone.h, view.y + view.h)

  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, x1 - x0, y1 - y0)
  ctx.clip()

  const plank = 34
  ctx.strokeStyle = palette.seam
  ctx.lineWidth = 1
  ctx.beginPath()
  const startRow = Math.floor((y0 - zone.y) / plank)
  for (let row = startRow; row * plank + zone.y <= y1; row += 1) {
    const y = zone.y + row * plank
    if (y < y0 - plank) continue
    ctx.moveTo(x0, y + 0.5)
    ctx.lineTo(x1, y + 0.5)
  }
  ctx.stroke()

  // staggered vertical seams
  ctx.strokeStyle = withAlpha('#6b4a2a', 0.16)
  for (let row = startRow; row * plank + zone.y <= y1; row += 1) {
    const y = zone.y + row * plank
    const offset = (row % 3) * 90
    for (let x = zone.x + offset; x < x1; x += 270) {
      if (x < x0) continue
      ctx.beginPath()
      ctx.moveTo(x + 0.5, Math.max(y, y0))
      ctx.lineTo(x + 0.5, Math.min(y + plank, y1))
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawTilePattern(ctx, zone, view) {
  const palette = floorPalette(zone.floor)
  const cell = palette.cell ?? 64
  const x0 = Math.max(zone.x, view.x)
  const y0 = Math.max(zone.y, view.y)
  const x1 = Math.min(zone.x + zone.w, view.x + view.w)
  const y1 = Math.min(zone.y + zone.h, view.y + view.h)
  if (x1 <= x0 || y1 <= y0) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, x1 - x0, y1 - y0)
  ctx.clip()
  ctx.strokeStyle = palette.seam
  ctx.lineWidth = 1.6
  ctx.beginPath()
  for (let x = Math.floor(x0 / cell) * cell; x <= x1; x += cell) {
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
  }
  for (let y = Math.floor(y0 / cell) * cell; y <= y1; y += cell) {
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
  }
  ctx.stroke()

  // alternating tile tint for a subtle chequer
  ctx.fillStyle = withAlpha('#ffffff', 0.05)
  const startX = Math.floor(x0 / cell)
  const startY = Math.floor(y0 / cell)
  for (let cx = startX; cx * cell <= x1; cx += 1) {
    for (let cy = startY; cy * cell <= y1; cy += 1) {
      if ((cx + cy) % 2 !== 0) continue
      ctx.fillRect(cx * cell, cy * cell, cell, cell)
    }
  }
  ctx.restore()
}

function drawCarpetPattern(ctx, zone, view) {
  const palette = floorPalette(zone.floor)
  const cell = palette.cell ?? 96
  const x0 = Math.max(zone.x, view.x)
  const y0 = Math.max(zone.y, view.y)
  const x1 = Math.min(zone.x + zone.w, view.x + view.w)
  const y1 = Math.min(zone.y + zone.h, view.y + view.h)
  if (x1 <= x0 || y1 <= y0) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(x0, y0, x1 - x0, y1 - y0)
  ctx.clip()
  // woven texture: a whisper-quiet dot matrix (no heavy pattern at this zoom)
  ctx.fillStyle = withAlpha('#ffffff', 0.05)
  for (let y = Math.floor(y0 / 12) * 12; y <= y1; y += 12) {
    for (let x = Math.floor(x0 / 12) * 12; x <= x1; x += 12) {
      ctx.fillRect(x, y, 1.2, 1.2)
    }
  }
  ctx.strokeStyle = withAlpha('#0b0f16', 0.05)
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = Math.floor(x0 / cell) * cell; x <= x1; x += cell) {
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
  }
  for (let y = Math.floor(y0 / cell) * cell; y <= y1; y += cell) {
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
  }
  ctx.stroke()
  ctx.restore()
}

export function drawFloors(ctx, camera) {
  const view = camera.visibleWorldRect()

  // base floor so wall shadows and letterboxing never show through gaps
  ctx.fillStyle = PALETTE.floors['carpet-grey'].base
  ctx.fillRect(WORLD.margin, WORLD.margin, WORLD.width - WORLD.margin * 2, WORLD.height - WORLD.margin * 2)

  for (const zone of visibleZones(camera)) {
    const palette = floorPalette(zone.floor)
    ctx.fillStyle = palette.base
    ctx.fillRect(zone.x, zone.y, zone.w, zone.h)

    if (palette.pattern === 'planks') drawPlankPattern(ctx, zone, view)
    else if (palette.pattern === 'tiles') drawTilePattern(ctx, zone, view)
    else drawCarpetPattern(ctx, zone, view)

    // room border: a hairline that separates floor materials cleanly
    ctx.strokeStyle = 'rgba(12, 17, 26, 0.18)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(zone.x + 0.75, zone.y + 0.75, zone.w - 1.5, zone.h - 1.5)
  }
}

// ------------------------------------------------------------- overlays -----

export function drawRugs(ctx, camera) {
  for (const overlay of visibleDecor(camera)) {
    if (overlay.type !== 'rug') continue
    const tones = { clay: '#a9745c', slate: '#66748c', sand: '#c8b295', indigo: '#4d5c8c' }
    const base = tones[overlay.tone] ?? tones.slate
    const rect = rectOf(overlay)

    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.fillStyle = base
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 10)
    ctx.fill()
    ctx.globalAlpha = 0.75
    ctx.strokeStyle = withAlpha(shade(base, -0.35), 0.6)
    ctx.lineWidth = 3
    roundRectPath(ctx, rect.x + 6, rect.y + 6, rect.w - 12, rect.h - 12, 7)
    ctx.stroke()
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = withAlpha('#ffffff', 0.35)
    ctx.lineWidth = 1.4
    roundRectPath(ctx, rect.x + 14, rect.y + 14, rect.w - 28, rect.h - 28, 5)
    ctx.stroke()
    ctx.restore()
  }
}

export function drawLightPools(ctx, camera) {
  for (const overlay of visibleDecor(camera)) {
    if (overlay.type !== 'lightPool') continue
    const rect = rectOf(overlay)
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    const radius = Math.max(rect.w, rect.h) / 2

    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius)
    gradient.addColorStop(0, `rgba(255, 246, 219, ${0.5 * (overlay.intensity ?? 0.5)})`)
    gradient.addColorStop(0.55, `rgba(255, 246, 219, ${0.16 * (overlay.intensity ?? 0.5)})`)
    gradient.addColorStop(1, 'rgba(255, 246, 219, 0)')
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    ctx.ellipse(cx, cy, rect.w / 2, rect.h / 2, 0, 0, Math.PI * 2)
    ctx.fillStyle = gradient
    ctx.fill()
    ctx.restore()

    // ceiling fixture hint
    if (camera.zoom > 0.75) {
      const w = Math.min(120, rect.w * 0.4)
      ctx.save()
      ctx.globalAlpha = 0.16
      ctx.fillStyle = '#fff6db'
      ctx.fillRect(cx - w / 2, cy - 5, w, 10)
      ctx.restore()
    }
  }
}

// ---------------------------------------------------------------- walls -----

export function drawWalls(ctx, camera) {
  const view = camera.visibleWorldRect()
  const { walls } = PALETTE

  const visible = WALLS.filter((wall) => {
    const minX = Math.min(wall.x1, wall.x2) - wall.thickness
    const maxX = Math.max(wall.x1, wall.x2) + wall.thickness
    const minY = Math.min(wall.y1, wall.y2) - wall.thickness
    const maxY = Math.max(wall.y1, wall.y2) + wall.thickness
    return maxX >= view.x && minX <= view.x + view.w && maxY >= view.y && minY <= view.y + view.h
  })

  ctx.save()
  ctx.lineCap = 'butt'

  // 1. shadow cast into the rooms (offset down-right, matching the light angle)
  ctx.save()
  ctx.translate(3, 5)
  ctx.strokeStyle = walls.shadow
  for (const wall of visible) {
    ctx.beginPath()
    ctx.moveTo(wall.x1, wall.y1)
    ctx.lineTo(wall.x2, wall.y2)
    ctx.lineWidth = wall.thickness + 6
    ctx.stroke()
  }
  ctx.restore()

  // 2. wall body — the dark side face
  ctx.strokeStyle = walls.face
  for (const wall of visible) {
    ctx.beginPath()
    ctx.moveTo(wall.x1, wall.y1)
    ctx.lineTo(wall.x2, wall.y2)
    ctx.lineWidth = wall.thickness
    ctx.stroke()
  }

  // 3. lit cap — an inset stroke reads as the wall's top surface
  ctx.strokeStyle = walls.top
  for (const wall of visible) {
    ctx.beginPath()
    ctx.moveTo(wall.x1, wall.y1)
    ctx.lineTo(wall.x2, wall.y2)
    ctx.lineWidth = Math.max(2, wall.thickness - 7)
    ctx.stroke()
  }

  // 4. specular hairline down the middle of the cap
  ctx.strokeStyle = walls.highlight
  ctx.lineWidth = 1.4
  for (const wall of visible) {
    ctx.beginPath()
    ctx.moveTo(wall.x1, wall.y1)
    ctx.lineTo(wall.x2, wall.y2)
    ctx.stroke()
  }

  ctx.restore()
}

// --------------------------------------------------------------- doors ------

export function drawDoors(ctx, camera) {
  const view = camera.visibleWorldRect()
  for (const door of DOORS) {
    const half = door.width / 2
    const vertical = door.orientation === 'vertical'
    const bounds = vertical
      ? { x: door.x - 30, y: door.y - half - 10, w: 60, h: door.width + 20 }
      : { x: door.x - half - 10, y: door.y - 30, w: door.width + 20, h: 60 }
    if (bounds.x > view.x + view.w || bounds.x + bounds.w < view.x) continue
    if (bounds.y > view.y + view.h || bounds.y + bounds.h < view.y) continue

    ctx.save()
    ctx.translate(door.x, door.y)
    if (vertical) ctx.rotate(Math.PI / 2)

    if (door.kind === 'opening') {
      // threshold band: the floor material changes here
      ctx.fillStyle = PALETTE.doors.threshold
      ctx.fillRect(-half, -7, door.width, 14)
      ctx.strokeStyle = withAlpha('#ffffff', 0.12)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-half, -7.5)
      ctx.lineTo(half, -7.5)
      ctx.moveTo(-half, 7.5)
      ctx.lineTo(half, 7.5)
      ctx.stroke()
    } else if (door.kind === 'glass') {
      const frame = 6
      ctx.fillStyle = withAlpha('#0d1420', 0.5)
      ctx.fillRect(-half, -8, door.width, 16)
      ctx.fillStyle = PALETTE.doors.glass
      ctx.fillRect(-half + frame, -7, door.width / 2 - frame - 4, 14)
      ctx.fillRect(4, -7, door.width / 2 - frame, 14)
      ctx.strokeStyle = PALETTE.doors.glassEdge
      ctx.lineWidth = 1.6
      ctx.strokeRect(-half + frame, -7, door.width / 2 - frame - 4, 14)
      ctx.strokeRect(4, -7, door.width / 2 - frame, 14)
      ctx.fillStyle = PALETTE.doors.frame
      ctx.fillRect(-half, -9, door.width, 3.5)
      ctx.fillRect(-half, 5.5, door.width, 3.5)
      // handles
      ctx.fillStyle = PALETTE.doors.handle
      ctx.fillRect(-6, -3, 12, 6)
      ctx.fillRect(6, -3, 3, 6)
    } else if (door.kind === 'double') {
      drawLeaf(ctx, -half, door.width / 2, door.swing, true)
      drawLeaf(ctx, half, -door.width / 2, -door.swing, true)
    } else {
      drawLeaf(ctx, door.swing > 0 ? -half : half, (door.swing > 0 ? 1 : -1) * door.width, door.swing, false)
    }

    ctx.restore()
  }
}

/** A single door leaf, drawn ajar with its swing arc. */
function drawLeaf(ctx, hingeX, direction, swing, mirrored) {
  const length = Math.abs(direction)
  const sign = Math.sign(direction) || 1
  const angle = sign * swing * 0.42 // ~24° open
  const thickness = mirrored ? 7 : 8

  ctx.save()
  ctx.translate(hingeX, 0)

  // swing arc, drawn first so the leaf sits on top of it
  ctx.beginPath()
  if (angle >= 0) ctx.arc(0, 0, length - 4, 0, angle)
  else ctx.arc(0, 0, length - 4, angle, 0)
  ctx.strokeStyle = withAlpha('#0b0f16', 0.15)
  ctx.lineWidth = 1
  ctx.stroke()

  // the leaf itself
  ctx.save()
  ctx.rotate(angle)
  ctx.fillStyle = withAlpha('#0b0f16', 0.25)
  ctx.fillRect(sign * 2, -thickness / 2 + 1.5, length - 4, thickness)
  ctx.fillStyle = PALETTE.doors.leaf
  ctx.fillRect(sign * 2, -thickness / 2, length - 4, thickness)
  ctx.strokeStyle = PALETTE.doors.leafEdge
  ctx.lineWidth = 1.2
  ctx.strokeRect(sign * 2, -thickness / 2, length - 4, thickness)
  ctx.strokeStyle = withAlpha('#4d3421', 0.45)
  ctx.beginPath()
  ctx.moveTo(sign * length * 0.45, -thickness / 2 + 1.5)
  ctx.lineTo(sign * length * 0.45, thickness / 2 - 1.5)
  ctx.stroke()
  ctx.fillStyle = PALETTE.doors.handle
  ctx.beginPath()
  ctx.arc(sign * (length - 12), 0, 2.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.restore()
}

// ------------------------------------------------------------ wall art ------

export function drawWallArt(ctx, camera) {
  for (const overlay of visibleDecor(camera)) {
    const rect = rectOf(overlay)
    ctx.save()
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)
    const horizontal = overlay.facing === 'north' || overlay.facing === 'south'

    if (overlay.type === 'whiteboard') {
      ctx.save()
      if (!horizontal) ctx.rotate(Math.PI / 2)
      const w = horizontal ? rect.w : rect.h
      const h = horizontal ? rect.h : rect.w
      ctx.fillStyle = PALETTE.metal.deepest
      ctx.fillRect(-w / 2 + 1, -h / 2 + 1, w, h)
      ctx.fillStyle = '#f4f7fa'
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.strokeStyle = withAlpha('#8e9aa6', 0.5)
      ctx.lineWidth = 1
      ctx.strokeRect(-w / 2, -h / 2, w, h)
      // sketched content
      ctx.strokeStyle = withAlpha(PALETTE.accents.indigo, 0.5)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(-w / 2 + 5, -h / 2 + h * 0.3)
      ctx.lineTo(-w / 2 + w * 0.4, -h / 2 + h * 0.3)
      ctx.moveTo(-w / 2 + 5, -h / 2 + h * 0.5)
      ctx.lineTo(-w / 2 + w * 0.62, -h / 2 + h * 0.5)
      ctx.stroke()
      ctx.fillStyle = withAlpha(PALETTE.accents.teal, 0.55)
      ctx.fillRect(-w / 2 + 5, -h / 2 + h * 0.68, w * 0.28, h * 0.12)
      ctx.restore()
    } else if (overlay.type === 'mirror') {
      ctx.save()
      ctx.rotate(Math.PI / 2)
      const w = rect.h
      const h = rect.w
      ctx.fillStyle = PALETTE.metal.deepest
      ctx.fillRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2)
      const gradient = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2)
      gradient.addColorStop(0, '#dcecf5')
      gradient.addColorStop(0.5, '#b9d3e2')
      gradient.addColorStop(1, '#e7f2f8')
      ctx.fillStyle = gradient
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.restore()
    } else if (overlay.type === 'artFrame') {
      ctx.save()
      if (!horizontal) ctx.rotate(Math.PI / 2)
      const w = horizontal ? rect.w : rect.h
      const h = horizontal ? rect.h : rect.w
      ctx.fillStyle = PALETTE.wood.deepest
      ctx.fillRect(-w / 2 - 1.5, -h / 2 - 1.5, w + 3, h + 3)
      ctx.fillStyle = '#efe7d8'
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.fillStyle = withAlpha(PALETTE.accents.coral, 0.75)
      ctx.beginPath()
      ctx.arc(-w * 0.1, h * 0.1, h * 0.24, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = withAlpha(PALETTE.accents.teal, 0.7)
      ctx.fillRect(-w / 2 + 3, h * 0.18, w - 6, h * 0.16)
      ctx.restore()
    } else if (overlay.type === 'signage') {
      const w = rect.w
      const h = rect.h
      ctx.fillStyle = PALETTE.fabric.indigoDark
      roundRectPath(ctx, -w / 2, -h / 2, w, h, 6)
      ctx.fill()
      ctx.strokeStyle = withAlpha('#c9d6ff', 0.35)
      ctx.lineWidth = 1.2
      roundRectPath(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 4)
      ctx.stroke()
      ctx.fillStyle = '#e8eeff'
      ctx.font = `700 ${Math.round(h * 0.5)}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(overlay.text ?? 'PROXISPEAK', 0, 1)
    }
    ctx.restore()
  }
}

// ---------------------------------------------------------- zone labels -----

/** Room names, drawn in screen space so they stay crisp at every zoom level. */
export function drawZoneLabels(ctx, camera, { showLabels = true, fade = 1 } = {}) {
  if (!showLabels || fade <= 0.01) return
  const view = camera.visibleWorldRect()

  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const zone of ZONES) {
    if (zone.x > view.x + view.w || zone.x + zone.w < view.x) continue
    if (zone.y > view.y + view.h || zone.y + zone.h < view.y) continue

    const point = camera.worldToScreen(zone.labelAt.x, zone.labelAt.y)
    const onScreen = point.x > -120 && point.x < camera.viewport.w + 120 && point.y > -40 && point.y < camera.viewport.h + 40
    if (!onScreen) continue

    // Hide the label when the room is too small on screen to host it.
    const widthPx = zone.w * camera.zoom
    if (widthPx < 150) continue

    const alpha = Math.min(1, widthPx / 260) * fade
    ctx.globalAlpha = alpha * 0.9

    ctx.font = LABEL_FONT
    const text = zone.name.toUpperCase()
    const textWidth = ctx.measureText(text).width
    const padding = 10
    const boxW = textWidth + padding * 2
    const boxH = 22

    roundRectPath(ctx, point.x - boxW / 2, point.y - boxH / 2, boxW, boxH, 6)
    ctx.fillStyle = 'rgba(12, 17, 26, 0.32)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(200, 218, 255, 0.14)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = PALETTE.labels.zone
    ctx.fillText(text, point.x, point.y + 0.5)

    // sub caption: what the room is for, in plain words
    if (zone.detail) {
      ctx.globalAlpha = alpha * 0.42
      ctx.font = SUBLABEL_FONT
      ctx.fillStyle = PALETTE.labels.zoneLetter
      ctx.fillText(zone.detail, point.x, point.y + 24)
    }
  }

  ctx.restore()
}

// ------------------------------------------------------------- vignette -----

/** Very light vignette + warm bloom, applied in screen space at the end. */
export function drawVignette(ctx, camera) {
  const { w, h } = camera.viewport
  const gradient = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
  gradient.addColorStop(0, 'rgba(0,0,0,0)')
  gradient.addColorStop(1, PALETTE.vignette)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, w, h)
}

/** Cheap environment probe for the HUD/tests. */
export function worldStats() {
  return { furniture: FURNITURE.length, zones: ZONES.length, zoneById: Object.keys(ZONE_BY_ID).length }
}

export { body, ellipse, rectOf }
