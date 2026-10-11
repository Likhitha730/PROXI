// Avatar renderer — original Canvas-drawn characters (no sprites, no images).
//
// Everything is vector work, so the avatars stay sharp at every zoom level and
// there is nothing to 404 at runtime.
//
// Contract
//   * `drawAvatar` paints a body in WORLD space with the feet at (avatar.x, avatar.y).
//     The caller has already applied the camera transform.
//   * `drawAvatarLabel` paints the name pill in SCREEN space, so text stays crisp
//     and never inherits the camera's scale.
//
// The renderer is stateless: position, facing, walk phase, blink phase and the
// speaking/proximity slots all arrive as data, which is exactly what the future
// network layer will provide for remote players.

import { PALETTE, shade, withAlpha } from './palette.js'
import { roundRectPath } from './furniture.js'

const AVATAR_SCALE = 1
const BODY = Object.freeze({
  legTop: -20,
  torsoTop: -40,
  torsoBottom: -18,
  shoulderY: -37,
  headY: -50,
  headRadius: 9.6,
  torsoWidth: 22,
})

const FACING_NAMES = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']

export function facingToIndex(facing) {
  const step = Math.PI / 4
  const index = Math.round((((facing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / step) % 8
  return index
}

export function facingName(facing) {
  return FACING_NAMES[facingToIndex(facing)]
}

/** Where the head sits this frame: lean into movement, bob while walking. */
function poseFor(avatar, walkPhase) {
  const index = facingToIndex(avatar.facing)
  const mode = index === 0 || index === 4 ? 'side' : index >= 1 && index <= 3 ? 'front' : 'back'
  const flip = index === 3 || index === 4 || index === 5
  const diagonal = index % 2 === 1
  const swing = Math.sin(walkPhase * Math.PI * 2)
  const lift = Math.abs(Math.sin(walkPhase * Math.PI * 2))
  const moving = avatar.moving ? 1 : 0

  return {
    index,
    mode,
    flip,
    diagonal,
    swing,
    lift,
    moving,
    // 3/4 view: shift the head/eyes toward the direction of travel
    leanX: (index === 0 ? 1 : index === 4 ? -1 : index === 1 ? 0.6 : index === 7 ? 0.6 : index === 3 ? -0.6 : index === 5 ? -0.6 : 0) * (moving ? 1.5 : 0.6),
    leanY: (index === 2 ? 0.8 : index === 6 ? -0.8 : index === 1 || index === 3 ? 0.4 : index === 5 || index === 7 ? -0.4 : 0) * (moving ? 1.2 : 0.4),
  }
}

// ------------------------------------------------------------------ parts ---

function drawShadow(ctx, pose) {
  const spread = pose.moving ? 1.06 : 1
  ctx.save()
  ctx.globalAlpha = 0.26
  ctx.beginPath()
  ctx.ellipse(1, 1.5, 14.5 * spread, 6.4 * spread, 0, 0, Math.PI * 2)
  ctx.fillStyle = '#0a0e15'
  ctx.fill()
  ctx.globalAlpha = 0.14
  ctx.beginPath()
  ctx.ellipse(1, 1.5, 19 * spread, 8.6 * spread, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawLegs(ctx, appearance, pose, walkPhase) {
  const swing = pose.swing
  const legW = 7.4
  const legH = 17

  for (const side of [-1, 1]) {
    const offset = side * 5
    const stepY = Math.max(0, side * swing) * 4.2
    const stepX = side * swing * 1.6 * (pose.mode === 'side' ? 1.6 : 1)
    const legX = offset + stepX
    const legY = BODY.torsoBottom - 1 - (side * swing > 0 ? 0 : 0)

    ctx.save()
    ctx.globalAlpha = 1
    // thigh/shin
    roundRectPath(ctx, legX - legW / 2, legY + stepY * -0.2, legW, legH + stepY * 0.2, 3)
    ctx.fillStyle = side === -1 ? shade(appearance.pants, -0.06) : appearance.pants
    ctx.fill()
    // shoe
    roundRectPath(ctx, legX - legW / 2 - 1.2, legY + legH - 3.4 + stepY, legW + 2.4, 6, 2.6)
    ctx.fillStyle = '#2b3140'
    ctx.fill()
    ctx.restore()
  }
  void walkPhase
}

function drawTorso(ctx, appearance, pose) {
  const bob = pose.moving ? pose.lift * 1.1 : 0
  const width = BODY.torsoWidth
  const top = BODY.torsoTop + bob
  const bottom = BODY.torsoBottom

  ctx.save()
  // shirt
  roundRectPath(ctx, -width / 2, top, width, bottom - top, 7)
  ctx.fillStyle = appearance.shirt
  ctx.fill()
  ctx.strokeStyle = withAlpha(shade(appearance.shirt, -0.45), 0.55)
  ctx.lineWidth = 1
  ctx.stroke()

  // collar + shoulder highlights (front/back only)
  if (pose.mode !== 'back') {
    ctx.beginPath()
    ctx.moveTo(-5.5, top + 1.5)
    ctx.lineTo(0, top + 5.5)
    ctx.lineTo(5.5, top + 1.5)
    ctx.strokeStyle = withAlpha(shade(appearance.shirt, 0.4), 0.7)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
  ctx.beginPath()
  roundRectPath(ctx, -width / 2 + 2, top + 2, width - 4, 6, 3)
  ctx.fillStyle = withAlpha('#ffffff', 0.07)
  ctx.fill()

  // local-player trim so "you" always reads instantly
  if (pose.isLocal) {
    roundRectPath(ctx, -width / 2 - 1.2, top - 1.2, width + 2.4, bottom - top + 2.4, 8)
    ctx.strokeStyle = withAlpha(PALETTE.accents.indigo, 0.85)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  // lanyard / badge slot
  if (appearance.accessory === 'badge' && pose.mode !== 'back') {
    ctx.strokeStyle = withAlpha('#e8eefc', 0.8)
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(-4, top + 4)
    ctx.lineTo(-5.5, top + 13)
    ctx.moveTo(4, top + 4)
    ctx.lineTo(5.5, top + 13)
    ctx.stroke()
    roundRectPath(ctx, -7.5, top + 12.5, 15, 10, 2)
    ctx.fillStyle = '#f1f5fb'
    ctx.fill()
    ctx.fillStyle = withAlpha(PALETTE.accents.indigo, 0.85)
    ctx.fillRect(-5.5, top + 15, 11, 2)
    ctx.fillStyle = withAlpha('#8e9aa6', 0.7)
    ctx.fillRect(-5.5, top + 18.4, 7, 1.6)
  }
  if (appearance.accessory === 'scarf' && pose.mode !== 'back') {
    roundRectPath(ctx, -width / 2 - 1, top + 1, width + 2, 6.5, 3)
    ctx.fillStyle = PALETTE.accents.coral
    ctx.fill()
  }
  ctx.restore()
  return bob
}

function drawArms(ctx, appearance, pose, bob) {
  const shoulderY = BODY.shoulderY + bob
  const swing = pose.swing
  const armColour = shade(appearance.shirt, -0.08)
  const skin = appearance.skin

  for (const side of [-1, 1]) {
    const step = -side * swing * 3.6
    const baseX = side * (BODY.torsoWidth / 2 - 1.5)
    const handX = baseX + side * 1.4
    const handY = shoulderY + 16 + step

    ctx.save()
    ctx.strokeStyle = armColour
    ctx.lineWidth = 6.4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(baseX, shoulderY + 1)
    ctx.lineTo(handX, handY - 2)
    ctx.stroke()
    // hand
    ctx.beginPath()
    ctx.arc(handX, handY, 2.9, 0, Math.PI * 2)
    ctx.fillStyle = skin
    ctx.fill()
    ctx.restore()
  }
}

function drawHead(ctx, appearance, pose, bob, time, blink) {
  const headX = pose.leanX * 0.9
  const headY = BODY.headY + bob + pose.leanY * 0.7
  const r = BODY.headRadius

  ctx.save()
  ctx.translate(headX, headY)

  // back hair sits behind the head
  const backHair = pose.mode === 'back' || appearance.hairStyle === 'long' || appearance.hairStyle === 'bun' || appearance.hairStyle === 'ponytail' || appearance.hairStyle === 'wavy'
  if (backHair) drawHairBack(ctx, appearance, r, pose)

  // head + ears
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fillStyle = appearance.skin
  ctx.fill()
  ctx.strokeStyle = withAlpha(shade(appearance.skin, -0.35), 0.6)
  ctx.lineWidth = 0.9
  ctx.stroke()

  if (pose.mode !== 'back') {
    ctx.beginPath()
    ctx.ellipse(-r + 0.4, 0.6, 2, 2.6, 0, 0, Math.PI * 2)
    ctx.ellipse(r - 0.4, 0.6, 2, 2.6, 0, 0, Math.PI * 2)
    ctx.fillStyle = shade(appearance.skin, -0.08)
    ctx.fill()
  }

  // face
  if (pose.mode === 'front' && !blink) {
    const eyeOffset = pose.diagonal ? pose.flip ? -1.6 : 1.6 : 0
    ctx.fillStyle = '#26303f'
    for (const side of [-1, 1]) {
      const ex = side * 3.4 + eyeOffset
      if (pose.diagonal && side * (pose.flip ? -1 : 1) > 0) continue
      ctx.beginPath()
      ctx.ellipse(ex, 1.2, 1.35, 1.7, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    // brows + mouth
    ctx.strokeStyle = withAlpha('#2a2118', 0.55)
    ctx.lineWidth = 0.9
    ctx.beginPath()
    ctx.moveTo(-4.6, -1.9)
    ctx.lineTo(-2.2, -2.4)
    ctx.moveTo(4.6, -1.9)
    ctx.lineTo(2.2, -2.4)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 4.4, 1.7, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.strokeStyle = withAlpha('#7d3f3a', 0.75)
    ctx.lineWidth = 1
    ctx.stroke()
  } else if (pose.mode === 'side') {
    const dir = pose.flip ? -1 : 1
    ctx.fillStyle = '#26303f'
    ctx.beginPath()
    ctx.ellipse(3.4 * dir, 1.2, 1.4, 1.7, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(5.2 * dir, 4.4, 1.4, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha('#7d3f3a', 0.6)
    ctx.fill()
  }

  // accessory: glasses / headphones / beard
  if (appearance.accessory === 'glasses' && pose.mode !== 'back') {
    ctx.strokeStyle = withAlpha('#2f3950', 0.9)
    ctx.lineWidth = 1.1
    if (pose.mode === 'side') {
      const dir = pose.flip ? -1 : 1
      ctx.beginPath()
      ctx.arc(3.4 * dir, 1.2, 3.1, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      for (const side of [-1, 1]) {
        ctx.beginPath()
        ctx.arc(side * 3.4, 1.2, 3.1, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.moveTo(-0.4, 1.2)
      ctx.lineTo(0.4, 1.2)
      ctx.stroke()
    }
  }
  if (appearance.accessory === 'beard' && pose.mode !== 'back') {
    ctx.beginPath()
    ctx.ellipse(0, 5.4, 6.2, 4.2, 0, 0, Math.PI)
    ctx.fillStyle = withAlpha(appearance.hair, 0.82)
    ctx.fill()
  }
  if (appearance.accessory === 'earrings' && pose.mode !== 'back') {
    ctx.fillStyle = PALETTE.accents.amber
    ctx.beginPath()
    ctx.arc(-r + 0.6, 3.2, 1.2, 0, Math.PI * 2)
    ctx.arc(r - 0.6, 3.2, 1.2, 0, Math.PI * 2)
    ctx.fill()
  }

  drawHairFront(ctx, appearance, r, pose)

  if (appearance.accessory === 'headphones') {
    ctx.strokeStyle = '#2f3950'
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.arc(0, -1.4, r + 1.6, Math.PI * 1.06, Math.PI * 1.94)
    ctx.stroke()
    for (const side of [-1, 1]) {
      roundRectPath(ctx, side * (r + 1.2) - 2.4, -2.4, 4.8, 7, 2)
      ctx.fillStyle = '#3a4459'
      ctx.fill()
    }
  }

  // speaking: a small pulse ring around the head
  if (pose.speaking) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 7)
    ctx.beginPath()
    ctx.arc(0, 1, r + 4 + pulse * 2.6, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(PALETTE.accents.green, 0.32 + pulse * 0.28)
    ctx.lineWidth = 1.8
    ctx.stroke()
  }
  if (pose.muted) {
    ctx.beginPath()
    ctx.moveTo(-r - 1, r - 3)
    ctx.lineTo(r + 1, -r + 3)
    ctx.strokeStyle = withAlpha(PALETTE.accents.coral, 0.8)
    ctx.lineWidth = 1.8
    ctx.stroke()
  }

  ctx.restore()
}

function drawHairBack(ctx, appearance, r, pose) {
  ctx.save()
  const colour = appearance.hair
  ctx.fillStyle = colour
  if (appearance.hairStyle === 'long' || appearance.hairStyle === 'wavy') {
    roundRectPath(ctx, -r - 1.6, -r + 1, (r + 1.6) * 2, r * 2.3, 5)
    ctx.fill()
  } else if (appearance.hairStyle === 'bun') {
    ctx.beginPath()
    ctx.arc(0, -r - 1.4, 4.4, 0, Math.PI * 2)
    ctx.fill()
  } else if (appearance.hairStyle === 'ponytail') {
    roundRectPath(ctx, -2.6, -r - 1, 5.2, r * 1.9, 2.6)
    ctx.fill()
  }
  void pose
  ctx.restore()
}

function drawHairFront(ctx, appearance, r, pose) {
  const colour = appearance.hair
  const dark = shade(colour, -0.18)
  if (pose.mode === 'back') {
    ctx.save()
    ctx.beginPath()
    ctx.arc(0, -0.4, r - 0.3, Math.PI, Math.PI * 2)
    ctx.fillStyle = colour
    ctx.fill()
    ctx.restore()
    return
  }

  ctx.save()
  switch (appearance.hairStyle) {
    case 'buzz':
      ctx.beginPath()
      ctx.arc(0, -1.1, r - 0.6, Math.PI * 1.02, Math.PI * 1.98)
      ctx.fillStyle = colour
      ctx.fill()
      break
    case 'short':
      ctx.beginPath()
      ctx.arc(0, -1.6, r + 0.5, Math.PI * 0.98, Math.PI * 2.02)
      ctx.fillStyle = colour
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(-r * 0.6, -r + 1.8, r * 0.5, r * 0.42, -0.4, 0, Math.PI * 2)
      ctx.fillStyle = shade(colour, 0.12)
      ctx.fill()
      break
    case 'side-part':
      ctx.beginPath()
      ctx.arc(0, -1.2, r + 0.4, Math.PI * 0.96, Math.PI * 2.04)
      ctx.fillStyle = colour
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(-r - 0.2, -1.2)
      ctx.quadraticCurveTo(-r * 0.2, -r - 3.4, r * 0.7, -r * 0.4)
      ctx.lineTo(-r - 0.2, -r * 0.1)
      ctx.closePath()
      ctx.fillStyle = dark
      ctx.fill()
      break
    case 'curly':
      for (let i = 0; i < 7; i += 1) {
        const angle = Math.PI + (Math.PI / 6) * i
        ctx.beginPath()
        ctx.arc(Math.cos(angle) * (r - 1), Math.sin(angle) * (r - 1.4) - 1.2, 3.3, 0, Math.PI * 2)
        ctx.fillStyle = i % 2 === 0 ? colour : shade(colour, 0.1)
        ctx.fill()
      }
      break
    case 'bun':
    case 'ponytail':
      ctx.beginPath()
      ctx.arc(0, -1.4, r + 0.3, Math.PI * 1.0, Math.PI * 2.0)
      ctx.fillStyle = colour
      ctx.fill()
      break
    case 'long':
    case 'wavy':
      ctx.beginPath()
      ctx.arc(0, -1.4, r + 0.5, Math.PI * 0.99, Math.PI * 2.01)
      ctx.fillStyle = colour
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(-r - 0.8, -2)
      ctx.quadraticCurveTo(-r - 3.4, 4.4, -r + 1.4, 8.4)
      ctx.lineTo(-r + 1.4, -2)
      ctx.closePath()
      ctx.fillStyle = dark
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(r + 0.8, -2)
      ctx.quadraticCurveTo(r + 3.4, 4.4, r - 1.4, 8.4)
      ctx.lineTo(r - 1.4, -2)
      ctx.closePath()
      ctx.fill()
      break
    default:
      ctx.beginPath()
      ctx.arc(0, -1.5, r + 0.3, Math.PI, Math.PI * 2)
      ctx.fillStyle = colour
      ctx.fill()
  }
  // sheen
  ctx.beginPath()
  ctx.ellipse(-r * 0.35, -r * 0.55, r * 0.42, r * 0.2, -0.5, 0, Math.PI * 2)
  ctx.fillStyle = withAlpha('#ffffff', 0.14)
  ctx.fill()
  ctx.restore()
}

function drawIndicatorSlots(ctx, avatar, pose, time) {
  const isLocal = Boolean(avatar.isLocal)
  const ringRadius = 20

  if (isLocal) {
    // local player: a soft floor ring, always visible so "you" is never ambiguous
    ctx.save()
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2)
    ctx.beginPath()
    ctx.ellipse(0, 1, ringRadius, ringRadius * 0.42, 0, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(PALETTE.accents.indigo, 0.5 + pulse * 0.16)
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
  }

  if (avatar.nearby) {
    // proximity slot: a teal halo when a peer is within audio range
    ctx.save()
    ctx.beginPath()
    ctx.ellipse(0, 1, ringRadius + 3.5, (ringRadius + 3.5) * 0.42, 0, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(PALETTE.accents.teal, 0.34)
    ctx.lineWidth = 2.4
    ctx.setLineDash([5, 6])
    ctx.lineDashOffset = -time * 10
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  if (avatar.speaking) {
    ctx.save()
    const pulse = 0.5 + 0.5 * Math.sin(time * 6.5)
    ctx.beginPath()
    ctx.ellipse(0, 1, ringRadius + 6 + pulse * 3, (ringRadius + 6 + pulse * 3) * 0.42, 0, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(PALETTE.accents.green, 0.30 + pulse * 0.25)
    ctx.lineWidth = 2.2
    ctx.stroke()
    ctx.restore()
  }

  // proximity markers are drawn after the body so they overlay the feet
  void pose
}

// ------------------------------------------------------------------ api -----

/**
 * Draw one avatar in world space.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   x:number, y:number, facing:number, moving?:boolean, walkPhase?:number,
 *   isLocal?:boolean, speaking?:boolean, muted?:boolean, nearby?:boolean,
 *   appearance: object
 * }} avatar
 * @param {{ time?: number, blink?: boolean, alpha?: number }} [options] `time` in seconds
 */
export function drawAvatar(ctx, avatar, options = {}) {
  const appearance = avatar.appearance
  if (!appearance) return false

  const time = options.time ?? 0
  const walkPhase = avatar.walkPhase ?? 0
  const pose = poseFor(avatar, walkPhase)
  pose.isLocal = avatar.isLocal
  pose.speaking = avatar.speaking
  pose.muted = avatar.muted

  const breathing = avatar.moving ? 0 : Math.sin(time * 1.7) * 0.55
  const blink = options.blink ?? false

  ctx.save()
  ctx.translate(avatar.x, avatar.y)
  if (AVATAR_SCALE !== 1) ctx.scale(AVATAR_SCALE, AVATAR_SCALE)
  if (options.alpha !== undefined) ctx.globalAlpha = options.alpha

  drawIndicatorSlots(ctx, avatar, pose, time)
  drawShadow(ctx, pose)
  drawLegs(ctx, appearance, pose, walkPhase)
  const bob = drawTorso(ctx, appearance, pose) + breathing
  drawArms(ctx, appearance, pose, bob)
  drawHead(ctx, appearance, pose, bob + breathing * 0.4, time, blink)

  // carried bag (procedural detail, drawn last so it hangs over the shoulder)
  if (appearance.hasBag && pose.mode !== 'front') {
    ctx.save()
    ctx.translate(pose.flip ? -9 : 9, -26)
    ctx.rotate(pose.mode === 'side' ? 0.2 : 0.1)
    roundRectPath(ctx, -5.5, -4, 11, 12, 3)
    ctx.fillStyle = '#4a3b2e'
    ctx.fill()
    ctx.strokeStyle = withAlpha('#2c2118', 0.6)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  ctx.restore()
  return true
}

/** Deterministic blink state: short blink every few seconds, per avatar. */
export function blinkState(seed, time) {
  const offset = (seed % 1000) / 1000 * 4
  const cycle = (time + offset) % 4.2
  return cycle > 4.05
}

/**
 * Draw the name pill in SCREEN space.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}} screenPoint feet position already projected to screen
 * @param {object} avatar
 * @param {{ zoom?: number, showNames?: boolean, badges?: object }} [options]
 */
export function drawAvatarLabel(ctx, screenPoint, avatar, options = {}) {
  const zoom = options.zoom ?? 1
  const showNames = options.showNames ?? true
  if (!showNames) return

  const name = avatar.name ?? 'Guest'
  const isLocal = Boolean(avatar.isLocal)
  const label = isLocal ? `${name} (you)` : name

  ctx.save()
  ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  const badges = []
  if (avatar.speaking) badges.push({ kind: 'mic', colour: PALETTE.accents.green })
  if (avatar.muted) badges.push({ kind: 'mute', colour: PALETTE.accents.coral })
  if (avatar.nearby) badges.push({ kind: 'near', colour: PALETTE.accents.teal })

  const textWidth = ctx.measureText(label).width
  const badgeWidth = badges.length * 13
  const padding = 8
  const height = 21
  const width = textWidth + badgeWidth + padding * 2

  // Keep the pill readable but not oversized when zoomed out.
  const scale = Math.max(0.78, Math.min(1.15, 0.72 + zoom * 0.34))
  const headHeight = 54 * zoom
  const y = screenPoint.y - headHeight - 12 * scale

  ctx.translate(screenPoint.x, y)
  ctx.scale(scale, scale)

  roundRectPath(ctx, -width / 2, -height / 2, width, height, 7)
  ctx.fillStyle = PALETTE.labels.bubble
  ctx.fill()
  ctx.strokeStyle = isLocal ? withAlpha(PALETTE.labels.localBadge, 0.85) : PALETTE.labels.bubbleBorder
  ctx.lineWidth = isLocal ? 1.6 : 1
  ctx.stroke()

  // little pointer
  ctx.beginPath()
  ctx.moveTo(-4, height / 2)
  ctx.lineTo(0, height / 2 + 4.5)
  ctx.lineTo(4, height / 2)
  ctx.closePath()
  ctx.fillStyle = PALETTE.labels.bubble
  ctx.fill()

  let cursorX = -width / 2 + padding
  for (const badge of badges) {
    ctx.beginPath()
    if (badge.kind === 'mic') {
      ctx.arc(cursorX + 4, 0, 4, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(badge.colour, 0.9)
      ctx.fill()
      ctx.strokeStyle = withAlpha('#0b0f16', 0.5)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#0b0f16'
      ctx.fillRect(cursorX + 2.6, -2.6, 2.6, 4.4)
      ctx.beginPath()
      ctx.arc(cursorX + 4, 1.6, 3.4, 0, Math.PI)
      ctx.strokeStyle = '#0b0f16'
      ctx.lineWidth = 1.1
      ctx.stroke()
    } else if (badge.kind === 'mute') {
      ctx.arc(cursorX + 4, 0, 4, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(badge.colour, 0.9)
      ctx.fill()
      ctx.strokeStyle = '#0b0f16'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(cursorX + 1.3, -2.7)
      ctx.lineTo(cursorX + 6.7, 2.7)
      ctx.moveTo(cursorX + 6.7, -2.7)
      ctx.lineTo(cursorX + 1.3, 2.7)
      ctx.stroke()
    } else {
      ctx.arc(cursorX + 4, 0, 3.4, 0, Math.PI * 2)
      ctx.strokeStyle = withAlpha(badge.colour, 0.95)
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cursorX + 4, 0, 1.3, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(badge.colour, 0.95)
      ctx.fill()
    }
    cursorX += 13
  }

  ctx.fillStyle = PALETTE.labels.bubbleText
  ctx.fillText(label, cursorX, 0.5)

  if (isLocal) {
    // subtle underline identifies the local player even without colour
    ctx.beginPath()
    ctx.moveTo(-width / 2 + padding, height / 2 - 3.5)
    ctx.lineTo(-width / 2 + padding + textWidth, height / 2 - 3.5)
    ctx.strokeStyle = withAlpha(PALETTE.labels.localBadge, 0.75)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  ctx.restore()

  // distance chip for nearby peers (audio range indicator)
  if (avatar.nearby && typeof avatar.distance === 'number') {
    ctx.save()
    ctx.font = '600 10px ui-sans-serif, system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const text = `${Math.round(avatar.distance)}u`
    const w = ctx.measureText(text).width + 12
    const chipY = y + 17 * scale
    roundRectPath(ctx, screenPoint.x - w / 2, chipY - 8, w, 16, 6)
    ctx.fillStyle = 'rgba(12, 17, 26, 0.7)'
    ctx.fill()
    ctx.strokeStyle = withAlpha(PALETTE.accents.teal, 0.5)
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = '#d7f4ee'
    ctx.fillText(text, screenPoint.x, chipY + 0.5)
    ctx.restore()
  }
}

export { BODY as AVATAR_BODY, poseFor }
