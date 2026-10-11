// World engine — the single requestAnimationFrame loop.
//
// Responsibilities
//   * one rAF loop with delta time clamped to 100 ms (a tab switch cannot teleport
//     the avatar or blow up the physics)
//   * device-pixel-ratio aware canvas sizing, driven by resize events rather than
//     by layout reads on every frame
//   * keyboard + pointer input (wheel zoom-to-cursor, drag pan, double-click reset)
//   * local avatar movement with circle-vs-AABB collision against walls/furniture
//   * camera follow / manual camera control
//   * depth-sorted rendering of furniture, decor and avatars
//   * pushing HUD state into `worldStore` at ~5 Hz — never per frame
//
// The engine owns no React state and no network code. Remote avatars are injected
// with `setPeers()` and render through exactly the same path as the local player,
// which is what the presence milestone will use.

import { Camera } from './camera.js'
import * as world from './worldRenderer.js'
import { drawFurnitureItem } from './furniture.js'
import { LIMITS } from '../../../shared/protocol.js'
import { blinkState, drawAvatar, drawAvatarLabel } from './avatarRenderer.js'
import { createLocalAppearance } from './avatarAppearance.js'
import { createKeyboardInput } from '../input/keyboard.js'
import {
  AVATAR_RADIUS,
  COLLIDER_GRID,
  DEFAULT_SPAWN,
  SPAWNS,
  WALKABLE_BOUNDS,
  WORLD,
  ZONES,
} from '../world/worldData.js'
import { resolveMovement } from '../world/collision.js'
import { damp, dampAngle, normalize } from '../world/math.js'
import { hashString } from '../world/random.js'

export const WALK_SPEED = 205 // world units per second
export const STRIDE_LENGTH = 36 // world units per full walk cycle
const HUD_INTERVAL_MS = 200
const MAX_FRAME_MS = 100
const ACCEL_LAMBDA = 16
const DECEL_LAMBDA = 20
const TURN_LAMBDA = 14
const MAX_DEVICE_PIXEL_RATIO = 2
const COLLIDER_QUERY_RADIUS = AVATAR_RADIUS + 80
const COLLIDER_QUERY_SLACK = 24

const noopStore = { set: () => {}, getSnapshot: () => ({}) }

function zoneAt(x, y) {
  for (const zone of ZONES) {
    if (x >= zone.x && x <= zone.x + zone.w && y >= zone.y && y <= zone.y + zone.h) return zone
  }
  return null
}

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   container?: HTMLElement | null,
 *   store?: { set: Function, getSnapshot: Function },
 *   playerName?: string,
 *   spawnId?: string,
 * }} options
 */
/**
 * The listening radius the ring is drawn with before the server has told us its
 * own value. Mirrors LIMITS.PROXIMITY_RADIUS — the server always wins once a
 * `proximity:update` has arrived.
 */
export const DEFAULT_PROXIMITY_RADIUS = LIMITS.PROXIMITY_RADIUS

export function createWorldEngine(options) {
  const {
    canvas,
    container = canvas?.parentElement ?? null,
    store = noopStore,
    playerName = 'You',
    spawnId = DEFAULT_SPAWN.id,
  } = options

  const ctx = canvas?.getContext?.('2d', { alpha: false }) ?? null
  if (!ctx) {
    return {
      start() {},
      destroy() {},
      getDiagnostics: () => ({ running: false, error: 'no-2d-context', frames: 0 }),
    }
  }

  const spawn = SPAWNS.find((entry) => entry.id === spawnId) ?? DEFAULT_SPAWN

  // ------------------------------------------------------------- state -----

  const player = {
    id: 'local',
    name: playerName,
    appearance: createLocalAppearance(playerName),
    isLocal: true,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: Math.PI / 2, // start looking into the lobby
    moving: false,
    walkPhase: 0,
    speaking: false,
    muted: false,
    nearby: false,
    blinkSeed: hashString(`local:${playerName}`),
  }

  const camera = new Camera({
    world: { x: 0, y: 0, w: WORLD.width, h: WORLD.height },
    x: player.x,
    y: player.y,
    zoom: 1,
    follow: true,
  })
  camera.followTarget = player

  /** Remote avatars: rendered here, simulated by the future network layer. */
  const peers = new Map()

  let running = false
  let frameHandle = null
  let lastTimestamp = 0
  let elapsed = 0
  let frames = 0
  let fpsFrames = 0
  let fpsWindowStart = 0
  let fps = 0
  let hudTimer = 0
  let showLabels = true
  let dragPointer = null

  // Network integration (see docs/ARCHITECTURE.md §6). All three are plain
  // callbacks so the engine stays network-agnostic and unit-testable:
  //   peerProvider    -> [] every frame, interpolated remote players
  //   stateReporter   -> local movement, published at ≤15 Hz
  //   correctionSource-> authoritative position the server sent after a reject
  let peerProvider = null
  let stateReporter = null
  let correctionSource = null
  // Proximity: the listening radius and the nearby set both come from the network
  // layer, so the engine only needs one read-only callback (see drawProximityRing).
  let proximitySource = null
  let reportTimer = 0
  let lastReported = { x: player.x, y: player.y, dir: player.facing, moving: false }
  let reportedMoves = 0

  let dpr = 1
  let viewportWidth = 960
  let viewportHeight = 540

  let nearbyColliders = []
  let colliderQueryCenter = { x: -9999, y: -9999 }
  const drawList = []

  // ------------------------------------------------------------ helpers ----

  /** Colliders around the player, refreshed only when the player leaves the cell. */
  function collidersNear(x, y) {
    if (
      Math.abs(x - colliderQueryCenter.x) > COLLIDER_QUERY_SLACK ||
      Math.abs(y - colliderQueryCenter.y) > COLLIDER_QUERY_SLACK
    ) {
      nearbyColliders = COLLIDER_GRID.queryUnique({
        x: x - COLLIDER_QUERY_RADIUS,
        y: y - COLLIDER_QUERY_RADIUS,
        w: COLLIDER_QUERY_RADIUS * 2,
        h: COLLIDER_QUERY_RADIUS * 2,
      })
      colliderQueryCenter = { x, y }
    }
    return nearbyColliders
  }

  /**
   * Measure the container and resize the backing store.
   * Called on mount, on resize and on device-pixel-ratio changes — never per frame.
   */
  function measure() {
    const rect = container?.getBoundingClientRect?.() ?? canvas.getBoundingClientRect?.() ?? null
    const cssWidth = Math.max(1, Math.round(rect?.width || container?.clientWidth || viewportWidth))
    const cssHeight = Math.max(1, Math.round(rect?.height || container?.clientHeight || viewportHeight))
    dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)

    viewportWidth = cssWidth
    viewportHeight = cssHeight

    const pixelWidth = Math.round(cssWidth * dpr)
    const pixelHeight = Math.round(cssHeight * dpr)
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    camera.setViewport(cssWidth, cssHeight)
  }

  function updatePlayer(dt) {
    const axis = keyboard.movementAxis()
    const wantsMove = axis.x !== 0 || axis.y !== 0
    const direction = normalize(axis.x, axis.y)
    const lambda = wantsMove ? ACCEL_LAMBDA : DECEL_LAMBDA

    player.vx = damp(player.vx, direction.x * WALK_SPEED, lambda, dt)
    player.vy = damp(player.vy, direction.y * WALK_SPEED, lambda, dt)

    const colliders = collidersNear(player.x, player.y)
    const resolved = resolveMovement({
      x: player.x,
      y: player.y,
      dx: player.vx * dt,
      dy: player.vy * dt,
      radius: AVATAR_RADIUS,
      colliders,
      bounds: WALKABLE_BOUNDS,
    })

    const travelled = Math.hypot(resolved.x - player.x, resolved.y - player.y)
    player.x = resolved.x
    player.y = resolved.y

    const speed = Math.hypot(player.vx, player.vy)
    if (speed < 4 && !wantsMove) {
      player.vx = 0
      player.vy = 0
    }

    // "moving" drives the walk cycle; a blocked player must not moonwalk in place
    player.moving = travelled > 0.02
    if (player.moving) {
      player.walkPhase = (player.walkPhase + travelled / STRIDE_LENGTH) % 1
      player.facing = dampAngle(player.facing, Math.atan2(player.vy, player.vx), TURN_LAMBDA, dt)
    } else {
      player.walkPhase = 0
    }
    player.speed = speed
  }

  // -------------------------------------------------------------- draw -----

  function drawSceneDepth() {
    drawList.length = 0

    for (const item of world.visibleFurniture(camera)) {
      drawList.push({ sortY: item.y + item.h / 2, kind: 'furniture', item })
    }
    drawList.push({ sortY: player.y, kind: 'avatar', avatar: player })
    for (const peer of peers.values()) {
      drawList.push({ sortY: peer.y, kind: 'avatar', avatar: peer })
    }

    drawList.sort((a, b) => a.sortY - b.sortY)

    for (const entry of drawList) {
      if (entry.kind === 'furniture') {
        drawFurnitureItem(ctx, entry.item)
      } else {
        drawAvatar(ctx, entry.avatar, {
          time: elapsed,
          blink: blinkState(entry.avatar.blinkSeed ?? 0, elapsed),
        })
      }
    }
  }

  /**
   * The proximity ring: a soft floor glow plus a crisp edge at exactly the listening
   * radius, drawn around the local avatar *under* furniture and avatars so it reads
   * as something on the floor. Remote players inside it also get a halo, so the
   * ring and the "nearby" list can never disagree about who is in range.
   */
  function drawProximityRing() {
    const reported = proximitySource?.()
    const rawRadius = Number(reported?.radius)
    const radius = Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : DEFAULT_PROXIMITY_RADIUS

    ctx.save()

    const glow = ctx.createRadialGradient(player.x, player.y, radius * 0.1, player.x, player.y, radius)
    glow.addColorStop(0, 'rgba(122, 226, 255, 0.14)')
    glow.addColorStop(0.72, 'rgba(122, 226, 255, 0.07)')
    glow.addColorStop(1, 'rgba(122, 226, 255, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2)
    ctx.fill()

    // Two rings: a wide translucent band that reads at any zoom, and a dashed line
    // that makes the exact boundary legible.
    ctx.strokeStyle = 'rgba(126, 224, 255, 0.30)'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(160, 240, 255, 0.55)'
    ctx.lineWidth = 2.5
    ctx.setLineDash([14, 10])
    ctx.lineDashOffset = -((elapsed * 12) % 24)
    ctx.beginPath()
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Halo under every nearby remote player: the visual counterpart of the list.
    for (const peer of peers.values()) {
      if (!peer.nearby) continue
      const distance = Math.hypot(peer.x - player.x, peer.y - player.y)
      const strength = Math.max(0.12, 1 - distance / radius)
      ctx.fillStyle = `rgba(126, 224, 255, ${(0.10 + strength * 0.16).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(peer.x, peer.y, AVATAR_RADIUS + 10, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = `rgba(170, 245, 255, ${(0.25 + strength * 0.45).toFixed(3)})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(peer.x, peer.y, AVATAR_RADIUS + 7, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.restore()
  }

  function drawNames() {
    const view = camera.visibleWorldRect()
    const label = (avatar) => {
      if (avatar.x < view.x - 90 || avatar.x > view.x + view.w + 90) return
      if (avatar.y < view.y - 140 || avatar.y > view.y + view.h + 90) return
      drawAvatarLabel(ctx, camera.worldToScreen(avatar.x, avatar.y), avatar, {
        zoom: camera.zoom,
        showNames: showLabels,
      })
    }
    label(player)
    for (const peer of peers.values()) label(peer)
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    world.drawBackdrop(ctx, camera)

    ctx.save()
    camera.applyTransform(ctx)
    world.drawWorldShadow(ctx)
    world.drawFloors(ctx, camera)
    world.drawRugs(ctx, camera)
    world.drawWalls(ctx, camera)
    world.drawDoors(ctx, camera)
    world.drawLightPools(ctx, camera)
    drawProximityRing()
    drawSceneDepth()
    world.drawWallArt(ctx, camera)
    ctx.restore()

    world.drawVignette(ctx, camera)
    world.drawZoneLabels(ctx, camera, { showLabels })
    drawNames()
  }

  // ------------------------------------------------------------ HUD sync ---

  /** The radius actually in use: the server's, or the documented default. */
  function proximityRadius() {
    const raw = Number(proximitySource?.()?.radius)
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROXIMITY_RADIUS
  }

  function syncHud(force = false) {
    const zone = zoneAt(player.x, player.y)
    let nearbyCount = 0
    for (const peer of peers.values()) if (peer.nearby) nearbyCount += 1

    store.set({
      engineReady: true,
      running,
      fps: Math.round(fps),
      drawsPerSecond: Math.round(fps),
      player: Object.freeze({
        x: Math.round(player.x),
        y: Math.round(player.y),
        moving: player.moving,
        facing: player.facing,
        speed: Math.round(player.speed),
      }),
      zoneName: zone ? zone.name : 'Corridor',
      zoom: Number(camera.zoom.toFixed(2)),
      follow: camera.follow,
      showLabels,
      nearbyCount,
      proximityRadius: proximityRadius(),
      peerCount: peers.size,
      ...(force ? { spawnId: spawn.id } : {}),
    })
  }

  // --------------------------------------------------------------- loop ----

  function frame(timestamp) {
    if (!running) return
    const dtSeconds =
      lastTimestamp === 0 ? 1 / 60 : Math.min((timestamp - lastTimestamp) / 1000, MAX_FRAME_MS / 1000)
    lastTimestamp = timestamp
    elapsed += dtSeconds
    frames += 1
    fpsFrames += 1

    updatePlayer(dtSeconds)
    if (correctionSource) {
      const correction = correctionSource()
      if (correction) applyServerPosition(correction.x, correction.y)
    }
    if (peerProvider) syncPeersFromProvider(peerProvider(timestamp))
    advancePeerWalk(dtSeconds)
    publishState(dtSeconds)
    camera.update(dtSeconds)
    render()

    if (fpsWindowStart === 0) fpsWindowStart = timestamp
    if (timestamp - fpsWindowStart >= 500) {
      fps = (fpsFrames * 1000) / (timestamp - fpsWindowStart)
      fpsFrames = 0
      fpsWindowStart = timestamp
    }

    hudTimer += dtSeconds * 1000
    if (hudTimer >= HUD_INTERVAL_MS) {
      hudTimer = 0
      syncHud()
    }

    frameHandle = globalThis.requestAnimationFrame(frame)
  }

  // ------------------------------------------------------------ actions ----

  const centerAnchor = () => ({ x: viewportWidth / 2, y: viewportHeight / 2 })

  function zoomIn() {
    camera.zoomBy(1.18, centerAnchor())
    syncHud()
    return camera.targetZoom
  }

  function zoomOut() {
    camera.zoomBy(1 / 1.18, centerAnchor())
    syncHud()
    return camera.targetZoom
  }

  function resetCamera() {
    camera.reset(player)
    syncHud()
  }

  function setFollow(enabled) {
    if (enabled) camera.followPlayer(player)
    else camera.setFollow(false)
    syncHud()
    return camera.follow
  }

  function toggleFollow() {
    return setFollow(!camera.follow)
  }

  function setShowLabels(enabled) {
    showLabels = Boolean(enabled)
    syncHud()
    return showLabels
  }

  function toggleLabels() {
    return setShowLabels(!showLabels)
  }

  /** Publish local movement at ≤15 Hz (plus an idle heartbeat, so a paused
   *  avatar still refreshes its position after a correction). */
  function publishState(dt) {
    if (!stateReporter) return
    reportTimer += dt * 1000
    const interval = 1000 / LIMITS.MOVE_UPDATES_PER_SECOND
    if (reportTimer < interval) return

    const moved =
      Math.abs(player.x - lastReported.x) > 0.5 ||
      Math.abs(player.y - lastReported.y) > 0.5 ||
      Math.abs(player.facing - lastReported.dir) > 0.08 ||
      player.moving !== lastReported.moving
    const heartbeatDue = reportTimer >= 2000
    if (!moved && !heartbeatDue) {
      reportTimer = Math.min(reportTimer, interval * 2)
      return
    }

    reportTimer = 0
    lastReported = { x: player.x, y: player.y, dir: player.facing, moving: player.moving }
    reportedMoves += 1
    stateReporter({
      x: Math.round(player.x * 100) / 100,
      y: Math.round(player.y * 100) / 100,
      dir: Math.round(player.facing * 1000) / 1000,
      moving: player.moving,
    })
  }

  /**
   * Snap the local avatar to the position the server accepted. This is the
   * visible half of "the server is authoritative": after a rejected move the
   * client stops guessing and adopts the server's coordinates.
   */
  function applyServerPosition(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const distance = Math.hypot(x - player.x, y - player.y)
    if (distance < 1) return false
    player.x = x
    player.y = y
    player.vx = 0
    player.vy = 0
    colliderQueryCenter = { x: -9999, y: -9999 }
    if (camera.follow) camera.centerOn(player.x, player.y)
    lastReported = { x: player.x, y: player.y, dir: player.facing, moving: player.moving }
    syncHud(true)
    return true
  }

  function teleportTo(id) {
    const target = SPAWNS.find((entry) => entry.id === id)
    if (!target) return false
    player.x = target.x
    player.y = target.y
    player.vx = 0
    player.vy = 0
    player.walkPhase = 0
    colliderQueryCenter = { x: -9999, y: -9999 }
    if (camera.follow) camera.centerOn(player.x, player.y)
    syncHud(true)
    return true
  }

  // ------------------------------------------------------------ keyboard ---

  const ACTION_HANDLERS = {
    'zoom-in': zoomIn,
    'zoom-out': zoomOut,
    'reset-zoom': () => camera.setZoom(1, { anchorScreen: centerAnchor() }),
    'reset-camera': resetCamera,
    'toggle-follow': toggleFollow,
    'toggle-labels': toggleLabels,
    'spawn-1': () => teleportTo(SPAWNS[0]?.id),
    'spawn-2': () => teleportTo(SPAWNS[1]?.id),
    'spawn-3': () => teleportTo(SPAWNS[2]?.id),
  }

  const keyboard = createKeyboardInput({
    onAction: (action) => {
      ACTION_HANDLERS[action]?.()
    },
  })

  // ------------------------------------------------------------ pointer ----

  function handleWheel(event) {
    event.preventDefault()
    const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 }
    camera.zoomBy(Math.exp(-event.deltaY * 0.0016), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    syncHud()
  }

  function handlePointerDown(event) {
    container?.focus?.({ preventScroll: true })
    if (event.button !== 0) return
    dragPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
    canvas.setPointerCapture?.(event.pointerId)
  }

  function handlePointerMove(event) {
    if (!dragPointer || event.pointerId !== dragPointer.id) return
    const dx = event.clientX - dragPointer.x
    const dy = event.clientY - dragPointer.y
    if (dx === 0 && dy === 0) return
    dragPointer.x = event.clientX
    dragPointer.y = event.clientY
    camera.panBy(dx, dy)
    syncHud()
  }

  function handlePointerUp(event) {
    if (!dragPointer || event.pointerId !== dragPointer.id) return
    canvas.releasePointerCapture?.(event.pointerId)
    dragPointer = null
    syncHud()
  }

  function handleDoubleClick() {
    resetCamera()
  }

  // ------------------------------------------------------------- resize ----

  let resizeObserver = null

  function handleResize() {
    measure()
    render()
    syncHud()
  }

  // ------------------------------------------------------------ lifecycle --

  function start() {
    if (running) return
    running = true
    keyboard.attach()

    canvas.addEventListener?.('wheel', handleWheel, { passive: false })
    canvas.addEventListener?.('pointerdown', handlePointerDown)
    canvas.addEventListener?.('pointermove', handlePointerMove)
    canvas.addEventListener?.('pointerup', handlePointerUp)
    canvas.addEventListener?.('pointercancel', handlePointerUp)
    canvas.addEventListener?.('dblclick', handleDoubleClick)

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(container ?? canvas)
    }
    globalThis.window?.addEventListener?.('resize', handleResize)

    measure()
    syncHud(true)
    lastTimestamp = 0
    fpsWindowStart = 0
    frameHandle = globalThis.requestAnimationFrame(frame)
  }

  function destroy() {
    running = false
    if (frameHandle !== null) {
      globalThis.cancelAnimationFrame?.(frameHandle)
      frameHandle = null
    }
    keyboard.detach()

    canvas.removeEventListener?.('wheel', handleWheel)
    canvas.removeEventListener?.('pointerdown', handlePointerDown)
    canvas.removeEventListener?.('pointermove', handlePointerMove)
    canvas.removeEventListener?.('pointerup', handlePointerUp)
    canvas.removeEventListener?.('pointercancel', handlePointerUp)
    canvas.removeEventListener?.('dblclick', handleDoubleClick)
    globalThis.window?.removeEventListener?.('resize', handleResize)
    resizeObserver?.disconnect?.()
    resizeObserver = null
    dragPointer = null

    peers.clear()
    drawList.length = 0
    nearbyColliders = []

    store.set({ running: false, engineReady: false, peerCount: 0, nearbyCount: 0 })
  }

  // --------------------------------------------------------------- peers ---

  function normalisePeer(peer) {
    return {
      id: peer.id,
      name: peer.name ?? 'Guest',
      appearance: peer.appearance ?? createLocalAppearance(peer.id),
      isLocal: false,
      x: peer.x ?? spawn.x,
      y: peer.y ?? spawn.y,
      facing: peer.facing ?? Math.PI / 2,
      moving: Boolean(peer.moving),
      walkPhase: peer.walkPhase ?? 0,
      speaking: Boolean(peer.speaking),
      muted: Boolean(peer.muted),
      nearby: Boolean(peer.nearby),
      distance: peer.distance,
      blinkSeed: peer.blinkSeed ?? hashString(String(peer.id)),
    }
  }

  /** Replace the peer list (used when a presence snapshot arrives). */
  function setPeers(list = []) {
    peers.clear()
    for (const peer of list) peers.set(peer.id, normalisePeer(peer))
    syncHud()
    return peers.size
  }

  /** Add or patch a single peer (used for incremental network updates). */
  function upsertPeer(peer) {
    const previous = peers.get(peer.id)
    const next = normalisePeer({ ...previous, ...peer })
    peers.set(peer.id, next)
    return next
  }

  function removePeer(id) {
    const removed = peers.delete(id)
    if (removed) syncHud()
    return removed
  }

  /**
   * Reconcile the live peer list against the network provider.
   *
   * The provider hands back the *same* objects every frame (the presence module
   * mutates them in place), so this only copies the fields that change at 15 Hz
   * and keeps render-only state — appearance, blink seed, walk phase, and the
   * previous frame position used to advance that phase.
   */
  function syncPeersFromProvider(list) {
    const seen = new Set()
    for (const remote of list) {
      if (!remote?.id) continue
      seen.add(remote.id)
      const existing = peers.get(remote.id)
      if (!existing) {
        const peer = normalisePeer(remote)
        peer.walkPhase = 0
        peer.lastX = peer.x
        peer.lastY = peer.y
        peers.set(remote.id, peer)
        continue
      }
      existing.name = remote.name ?? existing.name
      existing.x = remote.x
      existing.y = remote.y
      existing.facing = remote.facing ?? existing.facing
      existing.moving = Boolean(remote.moving)
      if (remote.speaking !== undefined) existing.speaking = Boolean(remote.speaking)
      if (remote.muted !== undefined) existing.muted = Boolean(remote.muted)
      if (remote.nearby !== undefined) existing.nearby = Boolean(remote.nearby)
      if (remote.distance !== undefined) existing.distance = remote.distance
      if (remote.stale !== undefined) existing.stale = Boolean(remote.stale)
    }
    for (const id of [...peers.keys()]) {
      if (!seen.has(id)) peers.delete(id)
    }
  }

  /** Advance the walk cycle of remote avatars from how far they really moved. */
  function advancePeerWalk(dt) {
    for (const peer of peers.values()) {
      const travelled = Math.hypot(peer.x - (peer.lastX ?? peer.x), peer.y - (peer.lastY ?? peer.y))
      peer.lastX = peer.x
      peer.lastY = peer.y
      if (peer.moving && travelled > 0.01) {
        peer.walkPhase = (peer.walkPhase + travelled / STRIDE_LENGTH) % 1
      } else if (!peer.moving) {
        peer.walkPhase = 0
      }
      peer.idleTime = (peer.idleTime ?? 0) + dt
    }
  }

  return {
    start,
    destroy,
    // network integration (all optional; the engine runs fine without them)
    setPeerProvider(provider) {
      peerProvider = typeof provider === 'function' ? provider : null
      return peerProvider !== null
    },
    setStateReporter(reporter) {
      stateReporter = typeof reporter === 'function' ? reporter : null
      return stateReporter !== null
    },
    /** Network layer hook: returns `{ radius }` for the ring (see presence.getProximity). */
    setProximitySource(source) {
      proximitySource = typeof source === 'function' ? source : null
    },

    setCorrectionSource(source) {
      correctionSource = typeof source === 'function' ? source : null
      return correctionSource !== null
    },
    reportNow() {
      if (stateReporter) {
        lastReported = { x: player.x, y: player.y, dir: player.facing, moving: player.moving }
        stateReporter({
          x: Math.round(player.x * 100) / 100,
          y: Math.round(player.y * 100) / 100,
          dir: Math.round(player.facing * 1000) / 1000,
          moving: player.moving,
        })
      }
    },
    applyServerPosition,
    setPlayerName(name) {
      if (typeof name === 'string' && name.trim()) player.name = name.trim()
      return player.name
    },
    // camera + view controls
    zoomIn,
    zoomOut,
    resetCamera,
    setFollow,
    toggleFollow,
    setShowLabels,
    toggleLabels,
    teleportTo,
    // peers (network-ready, no network here)
    setPeers,
    upsertPeer,
    removePeer,
    getPeers: () => [...peers.values()],
    // introspection (tests + HUD)
    getCamera: () => camera,
    getPlayer: () => player,
    getDiagnostics: () => ({
      running,
      frames,
      fps: Math.round(fps),
      elapsed,
      showLabels,
      spawnId: spawn.id,
      peers: peers.size,
      hasPeerProvider: peerProvider !== null,
      hasStateReporter: stateReporter !== null,
      reportedMoves,
      keyboardAttached: keyboard.attached,
      hasResizeObserver: Boolean(resizeObserver),
      viewport: { width: viewportWidth, height: viewportHeight, dpr },
      camera: camera.describe(),
      player: {
        x: Math.round(player.x),
        y: Math.round(player.y),
        facing: player.facing,
        moving: player.moving,
        walkPhase: player.walkPhase,
      },
    }),
  }
}
