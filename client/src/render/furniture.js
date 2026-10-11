// Furniture drawing library.
//
// Pure drawing module: it receives a 2D context and one declarative furniture item
// (see world/worldData.js) and paints it. No state, no DOM lookups, no network.
//
// Perspective contract shared by every item:
//   * the item's declared footprint (w × h) is the *top surface*
//   * a front face of `depth` pixels is drawn below it, giving the scene one
//     consistent 2.5D viewing angle
//   * `rot` (0/90/180/270) rotates the local frame, so details such as monitors
//     and chair backs always sit on the correct side
//
// Every drawer draws in local space: centred on (0, 0), footprint w × h, with the
// "front" of the object facing +y.

import { PALETTE, shade, withAlpha } from './palette.js'
import { createRngKit } from '../world/random.js'

// ------------------------------------------------------------- primitives ---

export function roundRectPath(ctx, x, y, w, h, r = 6) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
}

/**
 * The shared 2.5D body: soft shadow, darker front face, lit top surface.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w footprint width
 * @param {number} h footprint depth
 * @param {{top:string, side:string, edge?:string, depth?:number, radius?:number, shadow?:number, highlight?:boolean}} style
 */
export function body(ctx, w, h, style) {
  const { top, side, edge, depth = 8, radius = 6, shadow = 8, highlight = true } = style

  if (shadow > 0) {
    fillRoundRect(ctx, -w / 2 + 2, -h / 2 + depth * 0.4 + 3, w, h + depth * 0.6, radius, PALETTE.shadowSoft)
  }
  // front face (slightly inset so corners read cleanly)
  fillRoundRect(ctx, -w / 2, -h / 2 + depth, w, h, radius, side)
  // top surface
  fillRoundRect(ctx, -w / 2, -h / 2, w, h, radius, top)

  if (edge) {
    roundRectPath(ctx, -w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, radius)
    ctx.strokeStyle = edge
    ctx.lineWidth = 1
    ctx.stroke()
  }
  if (highlight) {
    ctx.beginPath()
    ctx.moveTo(-w / 2 + radius, -h / 2 + 1.5)
    ctx.lineTo(w / 2 - radius, -h / 2 + 1.5)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }
}

/** Horizontal wood grain lines — used on desks and tables. */
function grainLines(ctx, w, h, count = 4, colour = PALETTE.wood.grain) {
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  for (let i = 1; i <= count; i += 1) {
    const y = -h / 2 + (h / (count + 1)) * i
    ctx.beginPath()
    ctx.moveTo(-w / 2 + 8, y)
    ctx.lineTo(w / 2 - 8, y)
    ctx.stroke()
  }
}

const ellipse = (ctx, x, y, rx, ry, fill) => {
  ctx.beginPath()
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

// ------------------------------------------------------------------ props ---

/** Monitor: bezel, glowing panel and stand, facing the viewer. */
function propMonitor(ctx, x, y, scale = 1) {
  const w = 62 * scale
  const h = 34 * scale
  ctx.save()
  ctx.translate(x, y)
  // stand
  fillRoundRect(ctx, -6 * scale, -2 * scale, 12 * scale, 10 * scale, 2, PALETTE.metal.dark)
  ellipse(ctx, 0, 9 * scale, 12 * scale, 4 * scale, PALETTE.metal.deepest)
  // bezel
  fillRoundRect(ctx, -w / 2, -h - 4 * scale, w, h, 3, PALETTE.screen.frame)
  // panel
  const gradient = ctx.createLinearGradient(0, -h - 4 * scale, 0, -4 * scale)
  gradient.addColorStop(0, shade(PALETTE.screen.glow, -0.35))
  gradient.addColorStop(1, PALETTE.screen.glow)
  fillRoundRect(ctx, -w / 2 + 2.5, -h - 1.5 * scale, w - 5, h - 5, 2, gradient)
  // on-screen content hint
  ctx.fillStyle = PALETTE.screen.content
  fillRoundRect(ctx, -w / 2 + 7, -h + 1 * scale, w * 0.42, 3, 1.5, PALETTE.screen.content)
  fillRoundRect(ctx, -w / 2 + 7, -h + 7 * scale, w * 0.28, 3, 1.5, withAlpha('#d0e4ff', 0.32))
  ctx.restore()
}

function propKeyboard(ctx, x, y, width = 54) {
  fillRoundRect(ctx, x - width / 2, y - 8, width, 15, 3, '#3a4254')
  fillRoundRect(ctx, x - width / 2 + 2, y - 6, width - 4, 11, 2.5, '#4a5468')
  // key rows
  ctx.strokeStyle = 'rgba(210, 222, 240, 0.22)'
  ctx.lineWidth = 0.8
  for (let row = 0; row < 3; row += 1) {
    ctx.beginPath()
    ctx.moveTo(x - width / 2 + 5, y - 3.5 + row * 3)
    ctx.lineTo(x + width / 2 - 5, y - 3.5 + row * 3)
    ctx.stroke()
  }
}

/**
 * Mug seen from above: coral body, pale rim, coffee inside and a handle on the
 * side. The handle is what stops it reading as a dark dot on the desk.
 */
function propMug(ctx, x, y) {
  ctx.beginPath()
  ctx.ellipse(x + 6.4, y + 0.4, 3.2, 2.4, 0, 0, Math.PI * 2)
  ctx.fillStyle = PALETTE.accents.coral
  ctx.fill()
  ellipse(ctx, x, y, 6.4, 5.4, PALETTE.accents.coral)
  ellipse(ctx, x, y - 0.3, 5, 4.2, '#e8dccb')
  ellipse(ctx, x, y - 0.7, 4, 3.2, '#6b4a34')
  ellipse(ctx, x - 1.4, y - 1.8, 1.5, 1.1, withAlpha('#c99a72', 0.45))
}

function propNotebook(ctx, x, y) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(-0.12)
  fillRoundRect(ctx, -16, -11, 32, 22, 2, '#e7e2d6')
  fillRoundRect(ctx, -16, -11, 32, 5, 2, PALETTE.fabric.indigo)
  ctx.restore()
}

function propPhone(ctx, x, y) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(0.18)
  fillRoundRect(ctx, -13, -8, 26, 16, 3, '#333c4d')
  fillRoundRect(ctx, -11, -6, 17, 12, 2, '#4b5568')
  ctx.restore()
}

function propDeskPlant(ctx, x, y) {
  ellipse(ctx, x, y + 2, 9, 7, PALETTE.plant.pot)
  const kit = createRngKit(`deskplant-${x}-${y}`)
  for (let i = 0; i < 7; i += 1) {
    const angle = kit.range(0, Math.PI * 2)
    const radius = kit.range(2, 8)
    ellipse(
      ctx,
      x + Math.cos(angle) * radius,
      y - 3 + Math.sin(angle) * radius * 0.7,
      kit.range(3.4, 5.6),
      kit.range(2.8, 4.6),
      i % 2 === 0 ? PALETTE.plant.leaf : PALETTE.plant.leafDark,
    )
  }
}

function propPrinter(ctx, x, y) {
  fillRoundRect(ctx, x - 40, y - 26, 80, 46, 4, PALETTE.metal.base)
  fillRoundRect(ctx, x - 40, y - 30, 80, 12, 4, PALETTE.metal.light)
  fillRoundRect(ctx, x - 30, y - 16, 60, 10, 2, PALETTE.metal.deepest)
  fillRoundRect(ctx, x - 12, y + 12, 44, 8, 2, '#f2f5f8')
  ellipse(ctx, x + 28, y - 24, 4, 3, PALETTE.accents.green)
}

/** Countertop sink: steel rim, recessed basin with a drain, and a tall faucet. */
function propSink(ctx, x, y) {
  fillRoundRect(ctx, x - 27, y - 19, 54, 40, 7, withAlpha('#8d97a7', 0.35)) // outer shadow
  fillRoundRect(ctx, x - 26, y - 18, 52, 38, 6, PALETTE.metal.light)
  fillRoundRect(ctx, x - 21, y - 14, 42, 30, 5, '#6f7a8c')
  // rim highlight and a darker lower lip give the basin depth
  fillRoundRect(ctx, x - 21, y - 14, 42, 5, 4, withAlpha('#ffffff', 0.16))
  fillRoundRect(ctx, x - 19, y + 4, 38, 10, 4, withAlpha('#3f4757', 0.28))
  ellipse(ctx, x, y + 7, 4, 3, PALETTE.metal.deepest)
  ellipse(ctx, x, y + 6.4, 2, 1.4, withAlpha('#c3cbd7', 0.5))
  // faucet: stem, spout and a small lever
  ctx.strokeStyle = PALETTE.metal.light
  ctx.lineCap = 'round'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(x - 12, y - 15)
  ctx.lineTo(x - 12, y - 27)
  ctx.lineTo(x - 2, y - 27)
  ctx.stroke()
  ctx.strokeStyle = withAlpha('#ffffff', 0.6)
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(x - 13.4, y - 17)
  ctx.lineTo(x - 13.4, y - 26)
  ctx.stroke()
  fillRoundRect(ctx, x + 8, y - 30, 12, 4, 2, PALETTE.metal.base)
  fillRoundRect(ctx, x + 12, y - 34, 4, 5, 2, PALETTE.metal.base)
  ctx.lineCap = 'butt'
}

function propStove(ctx, x, y) {
  fillRoundRect(ctx, x - 30, y - 22, 60, 44, 5, '#3f4859')
  for (const [dx, dy] of [
    [-14, -9],
    [14, -9],
    [-14, 9],
    [14, 9],
  ]) {
    ellipse(ctx, x + dx, y + dy, 9, 7, '#2a3140')
    ellipse(ctx, x + dx, y + dy - 1, 6, 4.4, '#4d566a')
  }
}

function propCoffeeMachine(ctx, x, y) {
  fillRoundRect(ctx, x - 22, y - 26, 44, 44, 5, PALETTE.metal.dark)
  fillRoundRect(ctx, x - 17, y - 21, 34, 16, 3, '#2b3342')
  fillRoundRect(ctx, x - 13, y + 2, 26, 12, 2, PALETTE.metal.light)
  ellipse(ctx, x, y + 8, 7, 5, PALETTE.accents.coral)
}

function propTv(ctx, x, y, width = 150) {
  fillRoundRect(ctx, x - width / 2, y - 34, width, 62, 5, PALETTE.screen.frame)
  const gradient = ctx.createLinearGradient(0, y - 34, 0, y + 28)
  gradient.addColorStop(0, shade(PALETTE.screen.glow, -0.45))
  gradient.addColorStop(1, shade(PALETTE.screen.glow, -0.1))
  fillRoundRect(ctx, x - width / 2 + 4, y - 30, width - 8, 54, 3, gradient)
  fillRoundRect(ctx, x - width / 2 + 14, y - 18, width * 0.32, 6, 3, withAlpha('#e6f0ff', 0.5))
  fillRoundRect(ctx, x - width / 2 + 14, y - 6, width * 0.2, 5, 2.5, withAlpha('#e6f0ff', 0.32))
}

function propMagazine(ctx, x, y) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(0.2)
  fillRoundRect(ctx, -20, -13, 40, 26, 2, '#e9e4d8')
  fillRoundRect(ctx, -20, -13, 40, 7, 2, PALETTE.accents.teal)
  ctx.restore()
}

/** Front-desk service bell: dark base, bright dome, small plunger on top. */
function propBell(ctx, x, y) {
  ellipse(ctx, x, y + 3.5, 11.5, 6.5, PALETTE.metal.deepest)
  ellipse(ctx, x, y + 2.5, 11, 6, withAlpha(PALETTE.metal.base, 0.55))
  ctx.beginPath()
  ctx.arc(x, y + 1.5, 8, Math.PI, 0)
  ctx.closePath()
  ctx.fillStyle = PALETTE.metal.light
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y + 1.5, 8, Math.PI, 0)
  ctx.closePath()
  ctx.strokeStyle = withAlpha('#6f7787', 0.5)
  ctx.lineWidth = 0.8
  ctx.stroke()
  ellipse(ctx, x, y - 6.4, 2.6, 1.9, '#eef2f7')
  ellipse(ctx, x, y - 6.7, 1.6, 1.2, withAlpha('#ffffff', 0.8))
}

function propToilet(ctx, x, y) {
  fillRoundRect(ctx, x - 24, y - 30, 48, 22, 4, PALETTE.porcelain.shade)
  ellipse(ctx, x, y + 2, 20, 24, PALETTE.porcelain.base)
  ellipse(ctx, x, y + 2, 14, 17, PALETTE.porcelain.shade)
  ellipse(ctx, x, y + 3, 9, 11, '#c8d3db')
}

const PROPS = {
  monitor: (ctx, x, y, item) => propMonitor(ctx, x, y, item.w > 150 ? 1.05 : 0.92),
  keyboard: propKeyboard,
  mug: propMug,
  notebook: propNotebook,
  phone: propPhone,
  plant: propDeskPlant,
  printer: propPrinter,
  sink: propSink,
  stove: propStove,
  coffeeMachine: propCoffeeMachine,
  tv: propTv,
  magazine: propMagazine,
  bell: propBell,
  toilet: propToilet,
}

// -------------------------------------------------------------- drawers -----

/**
 * @typedef {(ctx: CanvasRenderingContext2D, w: number, h: number, item: object) => void} Drawer
 */

/** @type {Record<string, Drawer>} */
export const FURNITURE_DRAWERS = {
  desk(ctx, w, h, item) {
    const hasMonitor = item.props.includes('monitor')
    body(ctx, w, h, {
      top: PALETTE.wood.top,
      side: PALETTE.wood.mid,
      edge: withAlpha('#5d3c25', 0.45),
      depth: 10,
      radius: 7,
    })
    grainLines(ctx, w, h, 3)
    // modesty panel shadow along the far edge
    fillRoundRect(ctx, -w / 2 + 8, -h / 2 + 6, w - 16, 4, 2, withAlpha('#5d3c25', 0.16))

    if (item.props.includes('notebook')) propNotebook(ctx, -w / 2 + 34, h / 2 - 22)
    if (hasMonitor) propMonitor(ctx, 0, -h / 2 + 12, w > 150 ? 1.05 : 0.95)
    if (item.props.includes('keyboard')) propKeyboard(ctx, 0, h / 2 - 17, Math.min(62, w * 0.42))
    if (item.props.includes('mug')) propMug(ctx, w / 2 - 24, h / 2 - 20)
    if (item.props.includes('phone')) propPhone(ctx, -w / 2 + 26, h / 2 - 24)
    if (item.props.includes('plant')) propDeskPlant(ctx, w / 2 - 30, -h / 2 + 26)
  },

  chair(ctx, w, h) {
    // office chair, backrest at +y: seat faces -y (toward the desk)
    fillRoundRect(ctx, -w / 2 - 3, -h / 2 + 4, w + 6, h + 8, 8, PALETTE.shadowSoft)
    fillRoundRect(ctx, -w / 2, -h / 2, w, h, 7, PALETTE.fabric.slateDark)
    fillRoundRect(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 6, PALETTE.fabric.slate)
    // cushion highlight
    fillRoundRect(ctx, -w / 2 + 7, -h / 2 + 6, w - 14, h * 0.34, 5, withAlpha('#dfe6f2', 0.14))
    // backrest
    fillRoundRect(ctx, -w / 2 - 1, h / 2 - 8, w + 2, 12, 5, '#3f4859')
    fillRoundRect(ctx, -w / 2 + 4, h / 2 - 6, w - 8, 8, 4, PALETTE.fabric.slate)
    // arms
    fillRoundRect(ctx, -w / 2 - 2, -h / 4, 5, h / 2, 2.5, '#39414f')
    fillRoundRect(ctx, w / 2 - 3, -h / 4, 5, h / 2, 2.5, '#39414f')
  },

  cafeTable(ctx, w, h) {
    ellipse(ctx, 2, 6, w * 0.52, h * 0.4, PALETTE.shadowSoft)
    ctx.beginPath()
    ctx.ellipse(0, 4, w / 2 - 4, h / 2 - 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = PALETTE.wood.dark
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(0, 0, w / 2 - 4, h / 2 - 6, 0, 0, Math.PI * 2)
    ctx.fillStyle = PALETTE.wood.top
    ctx.fill()
    ctx.strokeStyle = withAlpha('#5d3c25', 0.4)
    ctx.lineWidth = 1.2
    ctx.stroke()
    ellipse(ctx, 0, 0, w / 2 - 15, h / 2 - 15, withAlpha('#ffffff', 0.08))
    propMug(ctx, -12, 6)
    propMug(ctx, 12, -4)
  },

  collabTable(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.wood.topDark, side: PALETTE.wood.dark, edge: withAlpha('#5d3c25', 0.5), depth: 12, radius: 10 })
    grainLines(ctx, w, h, 4)
    // central power grommet + scattered notes
    ellipse(ctx, 0, 0, 16, 11, PALETTE.metal.dark)
    ellipse(ctx, 0, -1, 12, 8, PALETTE.metal.base)
    ctx.save()
    ctx.translate(-w / 4, -h / 4)
    ctx.rotate(-0.16)
    fillRoundRect(ctx, -18, -12, 36, 24, 2, '#f1ece0')
    ctx.restore()
    ctx.save()
    ctx.translate(w / 4 + 6, h / 5)
    ctx.rotate(0.22)
    fillRoundRect(ctx, -16, -11, 32, 22, 2, '#e6eef7')
    ctx.restore()
    propMug(ctx, w / 3, -h / 4)
  },

  boardroomTable(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.wood.topDark, side: PALETTE.wood.dark, edge: withAlpha('#5d3c25', 0.55), depth: 14, radius: 16 })
    grainLines(ctx, w, h, 5)
    // inlay band
    roundRectPath(ctx, -w / 2 + 22, -h / 2 + 16, w - 44, h - 32, 10)
    ctx.strokeStyle = withAlpha('#4a2f1c', 0.35)
    ctx.lineWidth = 2
    ctx.stroke()
    // meeting kit: speaker puck, notepads, carafe
    ellipse(ctx, 0, -6, 22, 14, PALETTE.metal.dark)
    ellipse(ctx, 0, -8, 17, 10, PALETTE.metal.base)
    ellipse(ctx, 0, -9, 8, 5, '#2b3342')
    for (const [dx, dy] of [
      [-w / 2 + 60, -18],
      [-w / 2 + 60, 20],
      [w / 2 - 60, -18],
      [w / 2 - 60, 20],
    ]) {
      fillRoundRect(ctx, dx - 15, dy - 10, 30, 20, 2, '#efeadf')
    }
    ellipse(ctx, w / 2 - 110, 34, 12, 9, PALETTE.accents.teal)
    ellipse(ctx, w / 2 - 110, 32, 8, 6, withAlpha('#ffffff', 0.35))
  },

  sofa(ctx, w, h, item) {
    const seats = item.props.includes('3seat') ? 3 : 2
    body(ctx, w, h, { top: PALETTE.fabric.slate, side: PALETTE.fabric.slateDark, edge: withAlpha('#2c3444', 0.5), depth: 10, radius: 12 })
    // back cushion band
    fillRoundRect(ctx, -w / 2 + 6, -h / 2 + 4, w - 12, h * 0.36, 8, PALETTE.fabric.slateDark)
    fillRoundRect(ctx, -w / 2 + 10, -h / 2 + 7, w - 20, h * 0.22, 6, withAlpha('#e8edf6', 0.10))
    // seat cushions
    const gap = 6
    const seatW = (w - 20 - gap * (seats - 1)) / seats
    for (let i = 0; i < seats; i += 1) {
      const x = -w / 2 + 10 + i * (seatW + gap)
      fillRoundRect(ctx, x, h * 0.02, seatW, h * 0.34, 7, PALETTE.fabric.grey)
      fillRoundRect(ctx, x + 3, h * 0.02 + 3, seatW - 6, h * 0.16, 5, withAlpha('#ffffff', 0.10))
    }
    // arms
    fillRoundRect(ctx, -w / 2, -h / 2 + 6, 9, h - 12, 5, PALETTE.fabric.slateDark)
    fillRoundRect(ctx, w / 2 - 9, -h / 2 + 6, 9, h - 12, 5, PALETTE.fabric.slateDark)
    // throw pillow
    ctx.save()
    ctx.translate(w / 2 - 30, h / 2 - 18)
    ctx.rotate(-0.3)
    fillRoundRect(ctx, -13, -13, 26, 26, 6, PALETTE.accents.coral)
    fillRoundRect(ctx, -8, -8, 16, 16, 4, withAlpha('#ffffff', 0.16))
    ctx.restore()
  },

  armchair(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.fabric.indigo, side: PALETTE.fabric.indigoDark, edge: withAlpha('#2b3457', 0.5), depth: 10, radius: 12 })
    fillRoundRect(ctx, -w / 2 + 7, -h / 2 + 5, w - 14, h * 0.4, 8, PALETTE.fabric.indigoDark)
    fillRoundRect(ctx, -w / 2 + 10, h * 0.06, w - 20, h * 0.3, 7, PALETTE.fabric.indigo)
    fillRoundRect(ctx, -w / 2 + 13, h * 0.08, w - 26, h * 0.12, 5, withAlpha('#ffffff', 0.12))
    fillRoundRect(ctx, -w / 2, -h / 2 + 8, 9, h - 16, 5, PALETTE.fabric.indigoDark)
    fillRoundRect(ctx, w / 2 - 9, -h / 2 + 8, 9, h - 16, 5, PALETTE.fabric.indigoDark)
  },

  coffeeTable(ctx, w, h, item) {
    body(ctx, w, h, { top: PALETTE.wood.mid, side: PALETTE.wood.dark, edge: withAlpha('#5d3c25', 0.45), depth: 8, radius: 8 })
    grainLines(ctx, w, h, 2)
    if (item.props.includes('magazine')) propMagazine(ctx, 0, 0)
  },

  counter(ctx, w, h, item) {
    body(ctx, w, h, { top: '#e6ebf0', side: '#c3ccd6', edge: withAlpha('#6d7889', 0.45), depth: 14, radius: 6 })
    // cabinet fronts on the front face
    ctx.save()
    ctx.translate(0, 6)
    for (let i = 0; i < 4; i += 1) {
      const cw = (w - 30) / 4
      fillRoundRect(ctx, -w / 2 + 12 + i * (cw + 2), 2, cw - 4, 12, 2, '#d3dae2')
      fillRoundRect(ctx, -w / 2 + 12 + i * (cw + 2) + cw / 2 - 7, 6, 12, 3, 1.5, PALETTE.metal.base)
    }
    ctx.restore()
    // backsplash hint
    fillRoundRect(ctx, -w / 2 + 4, -h / 2 + 3, w - 8, 5, 3, withAlpha('#ffffff', 0.4))
    if (item.props.includes('coffeeMachine')) propCoffeeMachine(ctx, -w / 2 + 46, -6)
    if (item.props.includes('stove')) propStove(ctx, -6, 0)
    if (item.props.includes('sink')) propSink(ctx, w / 2 - 62, 0)
    // small appliance accessories
    ellipse(ctx, w / 2 - 16, -h / 2 + 18, 9, 7, PALETTE.metal.base)
    ellipse(ctx, w / 2 - 16, -h / 2 + 16, 6, 4.6, '#aab3c0')
  },

  fridge(ctx, w, h) {
    body(ctx, w, h, { top: '#eef2f6', side: '#c6cfd8', edge: withAlpha('#6d7889', 0.5), depth: 12, radius: 5 })
    fillRoundRect(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h * 0.5, 4, '#e2e8ee')
    // door split + handles
    ctx.strokeStyle = withAlpha('#8c98a8', 0.7)
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(-w / 2 + 4, -h / 2 + h * 0.52)
    ctx.lineTo(w / 2 - 4, -h / 2 + h * 0.52)
    ctx.stroke()
    fillRoundRect(ctx, w / 2 - 12, -h / 2 + 10, 4, h * 0.28, 2, PALETTE.metal.base)
    fillRoundRect(ctx, w / 2 - 12, -h / 2 + h * 0.6, 4, h * 0.26, 2, PALETTE.metal.base)
    // magnet + note
    fillRoundRect(ctx, -w / 2 + 12, -h / 2 + 12, 16, 12, 2, PALETTE.accents.amber)
    ellipse(ctx, -w / 2 + 30, -h / 2 + 30, 4, 3, PALETTE.accents.coral)
  },

  /**
   * Water cooler: a pale body, an upside-down bottle on top and a drip tray with
   * a cup. Drawn back to front so the bottle reads as a distinct silhouette —
   * without it the item looks like a blank tile on the floor.
   */
  waterCooler(ctx, w, h) {
    // bottle first (it sits above/behind the body in the y-sorted scene)
    fillRoundRect(ctx, -w * 0.29, -h * 0.46, w * 0.58, h * 0.42, 5, PALETTE.glass.fill)
    fillRoundRect(ctx, -w * 0.29, -h * 0.46, w * 0.58, h * 0.42, 5, withAlpha('#a8d6f0', 0.16))
    ctx.strokeStyle = PALETTE.glass.edge
    ctx.lineWidth = 1
    ctx.strokeRect(-w * 0.29, -h * 0.46, w * 0.58, h * 0.42)
    // neck facing down into the body
    fillRoundRect(ctx, -w * 0.1, -h * 0.1, w * 0.2, h * 0.12, 2, withAlpha('#cfe4f2', 0.5))
    // highlight down the left of the bottle
    fillRoundRect(ctx, -w * 0.22, -h * 0.38, w * 0.09, h * 0.26, 3, withAlpha('#ffffff', 0.35))

    body(ctx, w, h, { top: '#e4eaf1', side: '#bcc6d2', edge: withAlpha('#6d7889', 0.4), depth: 7, radius: 5 })

    // recessed dispenser alcove + two taps
    fillRoundRect(ctx, -w * 0.24, h * 0.02, w * 0.48, h * 0.26, 3, withAlpha('#8b97a8', 0.35))
    fillRoundRect(ctx, -w * 0.16, h * 0.08, w * 0.13, 3, 1.5, PALETTE.accents.teal)
    fillRoundRect(ctx, w * 0.03, h * 0.08, w * 0.13, 3, 1.5, PALETTE.accents.coral)
    // drip tray and a paper cup
    fillRoundRect(ctx, -w * 0.2, h * 0.28, w * 0.4, h * 0.1, 2, withAlpha('#7d8798', 0.5))
    ellipse(ctx, -w * 0.06, h * 0.33, 3.4, 2.6, '#f2f6f9')
    ellipse(ctx, -w * 0.06, h * 0.31, 3.4, 2.6, '#ffffff')
  },

  printerTable(ctx, w, h, item) {
    body(ctx, w, h, { top: PALETTE.metal.light, side: PALETTE.metal.dark, edge: withAlpha('#3f4757', 0.45), depth: 10, radius: 6 })
    if (item.props.includes('printer')) propPrinter(ctx, 0, 4)
  },

  shelfUnit(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.wood.mid, side: PALETTE.wood.dark, edge: withAlpha('#4a2f1c', 0.5), depth: 12, radius: 4 })
    // stacked boxes and binders
    const kit = createRngKit('shelf-unit')
    const colours = ['#cdb18a', '#b98a63', '#d8c3a3', PALETTE.fabric.indigo, PALETTE.accents.teal]
    for (let row = 0; row < 4; row += 1) {
      const y = -h / 2 + 14 + row * ((h - 22) / 4)
      for (let i = 0; i < 3; i += 1) {
        const bw = w * kit.range(0.2, 0.3)
        fillRoundRect(ctx, -w / 2 + 8 + i * (w * 0.29), y, bw, 12, 2, kit.pick(colours))
      }
      ctx.strokeStyle = withAlpha('#4a2f1c', 0.35)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-w / 2 + 5, y + 15)
      ctx.lineTo(w / 2 - 5, y + 15)
      ctx.stroke()
    }
  },

  bookshelf(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.wood.mid, side: PALETTE.wood.dark, edge: withAlpha('#4a2f1c', 0.5), depth: 12, radius: 4 })
    const kit = createRngKit(`bookshelf-${w}-${h}`)
    const spines = ['#8f4f46', '#3f6b8f', '#4f7f63', '#b08a4a', '#6b5a8f', '#a85f3f']
    for (let shelf = 0; shelf < 3; shelf += 1) {
      const y = -h / 2 + 12 + shelf * ((h - 20) / 3)
      let x = -w / 2 + 6
      while (x < w / 2 - 10) {
        const bw = kit.range(5, 9)
        fillRoundRect(ctx, x, y, bw, 16, 1.5, kit.pick(spines))
        x += bw + 1.6
      }
      fillRoundRect(ctx, -w / 2 + 4, y + 17, w - 8, 3, 1.5, withAlpha('#3b2415', 0.5))
    }
  },

  lockers(ctx, w, h) {
    const columns = 2
    const rows = 3
    body(ctx, w, h, { top: '#7f8a9b', side: '#5c6575', edge: withAlpha('#3f4757', 0.6), depth: 10, radius: 4 })
    for (let c = 0; c < columns; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const cw = (w - 12) / columns
        const ch = (h - 12) / rows
        const x = -w / 2 + 6 + c * cw
        const y = -h / 2 + 6 + r * ch
        fillRoundRect(ctx, x + 1, y + 1, cw - 2, ch - 2, 2, r % 2 === 0 ? '#8d98a9' : '#848f9f')
        // vent slits
        ctx.strokeStyle = withAlpha('#3f4757', 0.5)
        ctx.lineWidth = 1
        for (let v = 0; v < 3; v += 1) {
          ctx.beginPath()
          ctx.moveTo(x + 4, y + 6 + v * 3)
          ctx.lineTo(x + cw - 6, y + 6 + v * 3)
          ctx.stroke()
        }
        ellipse(ctx, x + cw - 7, y + ch - 7, 2, 2, PALETTE.metal.deepest)
      }
    }
  },

  filingCabinet(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.metal.base, side: PALETTE.metal.dark, edge: withAlpha('#3f4757', 0.5), depth: 8, radius: 4 })
    for (let r = 0; r < 3; r += 1) {
      const ch = (h - 12) / 3
      const y = -h / 2 + 6 + r * ch
      fillRoundRect(ctx, -w / 2 + 5, y + 2, w - 10, ch - 4, 2, '#98a2b1')
      fillRoundRect(ctx, -9, y + ch / 2 - 2, 18, 4, 2, PALETTE.metal.deepest)
    }
  },

  plant(ctx, w, h, item) {
    const kit = createRngKit(`plant-${item.x}-${item.y}-${item.tint ?? 'lush'}`)
    const lush = item.tint !== 'slim'
    const calm = item.tint === 'calm'
    const leafColours = calm
      ? [PALETTE.plant.leafCalm, PALETTE.plant.leafDark]
      : [PALETTE.plant.leaf, PALETTE.plant.leafLight, PALETTE.plant.leafDark]

    // shadow + pot
    ellipse(ctx, 2, h * 0.24, w * 0.42, h * 0.2, PALETTE.shadow)
    ctx.beginPath()
    ctx.moveTo(-w * 0.32, -h * 0.02)
    ctx.lineTo(w * 0.32, -h * 0.02)
    ctx.lineTo(w * 0.24, h * 0.36)
    ctx.lineTo(-w * 0.24, h * 0.36)
    ctx.closePath()
    ctx.fillStyle = PALETTE.plant.pot
    ctx.fill()
    ctx.strokeStyle = withAlpha('#5c3220', 0.4)
    ctx.lineWidth = 1
    ctx.stroke()
    ellipse(ctx, 0, -h * 0.02, w * 0.32, h * 0.1, PALETTE.plant.potLight)
    ellipse(ctx, 0, -h * 0.03, w * 0.26, h * 0.07, PALETTE.plant.soil)

    // foliage clusters
    const clusters = lush ? 11 : 7
    for (let i = 0; i < clusters; i += 1) {
      const angle = kit.range(0, Math.PI * 2)
      const radius = kit.range(w * 0.08, w * 0.44)
      const cx = Math.cos(angle) * radius
      const cy = -h * 0.16 + Math.sin(angle) * radius * 0.8
      const rx = kit.range(w * 0.18, w * 0.3)
      ellipse(ctx, cx, cy, rx, rx * 0.82, kit.pick(leafColours))
    }
    // a couple of brighter highlights for depth
    for (let i = 0; i < 3; i += 1) {
      const angle = kit.range(0, Math.PI * 2)
      const radius = kit.range(w * 0.05, w * 0.22)
      ellipse(ctx, Math.cos(angle) * radius, -h * 0.2 + Math.sin(angle) * radius * 0.7, w * 0.12, w * 0.1, withAlpha('#bfe8c9', 0.5))
    }
  },

  stall(ctx, w, h, item) {
    // cubicle: floor tile, partition walls, toilet
    fillRoundRect(ctx, -w / 2, -h / 2, w, h, 3, '#cfd9e0')
    fillRoundRect(ctx, -w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 2, '#dae2e8')
    // partitions on three sides (open toward +y)
    ctx.strokeStyle = '#a9b6c2'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(-w / 2 + 2, -h / 2 + 2)
    ctx.lineTo(-w / 2 + 2, h / 2 - 2)
    ctx.moveTo(w / 2 - 2, -h / 2 + 2)
    ctx.lineTo(w / 2 - 2, h / 2 - 2)
    ctx.moveTo(-w / 2 + 2, -h / 2 + 2)
    ctx.lineTo(w / 2 - 2, -h / 2 + 2)
    ctx.stroke()
    ctx.strokeStyle = withAlpha('#ffffff', 0.35)
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(-w / 2 + 3.5, -h / 2 + 3)
    ctx.lineTo(-w / 2 + 3.5, h / 2 - 3)
    ctx.stroke()
    if (item.props.includes('toilet')) propToilet(ctx, 0, -8)
  },

  sinkUnit(ctx, w, h) {
    body(ctx, w, h, { top: PALETTE.porcelain.base, side: PALETTE.porcelain.dark, edge: withAlpha('#8e9aa6', 0.45), depth: 8, radius: 6 })
    ellipse(ctx, 0, 0, w * 0.28, h * 0.26, PALETTE.porcelain.shade)
    ellipse(ctx, 0, 0, w * 0.2, h * 0.18, '#c5d0d8')
    ellipse(ctx, 0, h * 0.28, 4, 3, PALETTE.metal.dark)
    ctx.strokeStyle = PALETTE.metal.light
    ctx.lineWidth = 3.4
    ctx.beginPath()
    ctx.moveTo(0, -h * 0.26)
    ctx.lineTo(0, -h * 0.4)
    ctx.lineTo(w * 0.16, -h * 0.4)
    ctx.stroke()
  },

  credenza(ctx, w, h, item) {
    body(ctx, w, h, { top: PALETTE.wood.mid, side: PALETTE.wood.dark, edge: withAlpha('#4a2f1c', 0.5), depth: 10, radius: 6 })
    grainLines(ctx, w, h, 2)
    for (let i = 0; i < 3; i += 1) {
      const cw = (w - 16) / 3
      fillRoundRect(ctx, -w / 2 + 6 + i * cw, -h / 2 + 8, cw - 4, h - 20, 2, withAlpha('#5d3c25', 0.25))
      fillRoundRect(ctx, -w / 2 + 6 + i * cw + cw / 2 - 8, -h / 2 + h / 2 - 6, 16, 3.5, 1.6, PALETTE.metal.light)
    }
    if (item.props.includes('tv')) propTv(ctx, 0, -h / 2 + 16, Math.min(150, w * 0.72))
  },

  receptionDesk(ctx, w, h, item) {
    body(ctx, w, h, { top: '#d9b98d', side: PALETTE.wood.mid, edge: withAlpha('#4a2f1c', 0.45), depth: 14, radius: 10 })
    grainLines(ctx, w, h, 3)
    // branded front panel
    fillRoundRect(ctx, -w / 2 + 10, h / 2 - 6, w - 20, 18, 3, PALETTE.fabric.indigo)
    fillRoundRect(ctx, -w / 2 + 16, h / 2 - 2, w - 32, 8, 2, withAlpha('#dfe8ff', 0.22))
    if (item.props.includes('monitor')) propMonitor(ctx, -w / 4, -h / 4, 0.9)
    if (item.props.includes('bell')) propBell(ctx, w / 4 + 10, -h / 4)
    if (item.props.includes('mug')) propMug(ctx, w / 4 - 30, h / 4 - 4)
    // visitor sign-in tablet
    ctx.save()
    ctx.translate(-w / 2 + 34, h / 4)
    ctx.rotate(-0.06)
    fillRoundRect(ctx, -18, -13, 36, 26, 3, '#2c3444')
    fillRoundRect(ctx, -15, -10, 30, 20, 2, PALETTE.screen.glowSoft)
    ctx.restore()
  },
}

/** Furniture types that have a drawer (used by tests to catch typos). */
export const FURNITURE_TYPES = Object.freeze(Object.keys(FURNITURE_DRAWERS))

/**
 * Draw one furniture item in world space.
 *
 * The caller has already applied the camera transform; this function only
 * translates/rotates into the item's local frame.
 */
export function drawFurnitureItem(ctx, item) {
  const drawer = FURNITURE_DRAWERS[item.type]
  if (!drawer) return false

  const swapped = item.rot === 90 || item.rot === 270
  const w = swapped ? item.h : item.w
  const h = swapped ? item.w : item.h

  ctx.save()
  ctx.translate(item.x, item.y)
  if (item.rot) ctx.rotate((item.rot * Math.PI) / 180)
  drawer(ctx, w, h, item)
  ctx.restore()
  return true
}

export { PROPS, body as furnitureBody, grainLines, ellipse }
