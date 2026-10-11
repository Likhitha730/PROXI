/**
 * Engine tests: the animation loop, movement, collision, HUD throttling and
 * teardown. These run in jsdom with a fake rAF and a fake 2D context, so every
 * frame is deterministic and every assertion is exact.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorldEngine, STRIDE_LENGTH, WALK_SPEED } from './engine.js'
import { createFakeCanvas, createFakeContext, installFakeRaf, pressKey, tapKey } from '../test/fakeCanvas.js'
import { SPAWNS, STATIC_COLLIDERS, WALKABLE_BOUNDS, ZONES } from '../world/worldData.js'
import { circleHitsAny } from '../world/collision.js'
import { AVATAR_RADIUS } from '../world/worldData.js'

let raf
let engine
let canvas
let store
let container

function createStore() {
  const writes = []
  let state = {}
  return {
    writes,
    getSnapshot: () => state,
    set(patch) {
      writes.push(patch)
      state = { ...state, ...patch }
      return state
    },
  }
}

function createContainer(width = 1024, height = 640) {
  const element = globalThis.document.createElement('div')
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height })
  element.focus = () => {}
  globalThis.document.body.appendChild(element)
  return element
}

beforeEach(() => {
  raf = installFakeRaf()
  store = createStore()
  container = createContainer()
  canvas = createFakeCanvas(1024, 640, createFakeContext({ width: 1024, height: 640 }))
  globalThis.devicePixelRatio = 1
})

afterEach(() => {
  engine?.destroy()
  engine = null
  container?.remove()
  raf.restore()
})

function startEngine(options = {}) {
  engine = createWorldEngine({ canvas, container, store, playerName: 'You', spawnId: 'entrance', ...options })
  engine.start()
  return engine
}

const holdKeys = (...codes) => codes.forEach((code) => pressKey(code))
const releaseKeys = (...codes) => codes.forEach((code) => pressKey(code, { type: 'keyup' }))

describe('loop lifecycle', () => {
  it('starts a single animation frame and reports running', () => {
    startEngine()
    const diagnostics = engine.getDiagnostics()
    expect(diagnostics.running).toBe(true)
    expect(diagnostics.keyboardAttached).toBe(true)
    expect(raf.hasPendingFrame).toBe(true)
  })

  it('renders on every frame and keeps scheduling', () => {
    startEngine()
    const before = engine.getDiagnostics().frames
    raf.step(5)
    expect(engine.getDiagnostics().frames).toBe(before + 5)
    expect(raf.hasPendingFrame).toBe(true)
  })

  it('clamps a huge delta time (tab switch) instead of teleporting the avatar', () => {
    startEngine()
    raf.step(1, 16)
    holdKeys('KeyD')
    const before = engine.getPlayer().x
    raf.step(1, 5_000) // 5 seconds in one frame
    const travelled = engine.getPlayer().x - before
    expect(travelled).toBeLessThan(WALK_SPEED * 0.11) // clamped to 100 ms
  })

  it('cancels the frame and detaches everything on destroy', () => {
    startEngine()
    raf.step(3)
    const listenersBefore = canvas.listenerCount()
    expect(listenersBefore).toBeGreaterThan(0)

    engine.destroy()
    expect(engine.getDiagnostics().running).toBe(false)
    expect(engine.getDiagnostics().keyboardAttached).toBe(false)
    expect(raf.hasPendingFrame).toBe(false)
    expect(canvas.listenerCount()).toBe(0)
    expect(raf.stats.cancelled).toBeGreaterThan(0)
  })

  it('does not process input after destroy (no leaked listeners)', () => {
    startEngine()
    raf.step(1)
    const player = engine.getPlayer()
    const startX = player.x
    engine.destroy()

    holdKeys('KeyD')
    raf.step(10)
    expect(player.x).toBe(startX) // nothing moved
  })

  it('is safe to call destroy twice', () => {
    startEngine()
    engine.destroy()
    expect(() => engine.destroy()).not.toThrow()
  })

  it('falls back gracefully when the canvas has no 2D context', () => {
    const broken = createFakeCanvas(800, 600, null)
    broken.getContext = () => null
    const weak = createWorldEngine({ canvas: broken, container, store })
    expect(() => weak.start()).not.toThrow()
    expect(weak.getDiagnostics().running).toBe(false)
  })
})

describe('movement and facing', () => {
  it('walks in the pressed direction and faces it', () => {
    startEngine()
    raf.step(1)
    const start = { ...engine.getPlayer() }
    holdKeys('KeyD')
    raf.step(30)
    const after = engine.getPlayer()
    expect(after.x).toBeGreaterThan(start.x + 40)
    expect(Math.abs(after.y - start.y)).toBeLessThan(2)
    expect(after.facing).toBeCloseTo(0, 1) // walking east
    expect(after.moving).toBe(true)
  })

  it('supports the arrow keys as well as WASD', () => {
    startEngine()
    raf.step(1)
    const startY = engine.getPlayer().y
    holdKeys('ArrowUp')
    raf.step(20)
    expect(engine.getPlayer().y).toBeLessThan(startY - 20)
    releaseKeys('ArrowUp')
    holdKeys('ArrowDown')
    raf.step(30)
    expect(engine.getPlayer().y).toBeGreaterThan(startY - 5)
  })

  it('stops and idles when keys are released', () => {
    startEngine()
    raf.step(1)
    holdKeys('KeyW')
    raf.step(20)
    expect(engine.getPlayer().moving).toBe(true)
    releaseKeys('KeyW')
    raf.step(40)
    const player = engine.getPlayer()
    expect(player.moving).toBe(false)
    expect(player.walkPhase).toBe(0)
    expect(Math.hypot(player.vx, player.vy)).toBeLessThan(5)
  })

  it('moves diagonally at the same speed as straight (normalised input)', () => {
    startEngine()
    raf.step(1)
    const startA = { x: engine.getPlayer().x, y: engine.getPlayer().y }
    holdKeys('KeyD')
    raf.step(60)
    const straight = Math.hypot(engine.getPlayer().x - startA.x, engine.getPlayer().y - startA.y)
    releaseKeys('KeyD')

    engine.teleportTo('entrance')
    raf.step(1)
    const startB = { x: engine.getPlayer().x, y: engine.getPlayer().y }
    holdKeys('KeyD', 'KeyS')
    raf.step(60)
    const diagonal = Math.hypot(engine.getPlayer().x - startB.x, engine.getPlayer().y - startB.y)

    expect(diagonal).toBeGreaterThan(straight * 0.6)
    expect(diagonal).toBeLessThan(straight * 1.15)
  })

  it('advances the walk cycle with distance travelled, not with time', () => {
    startEngine()
    raf.step(1)
    holdKeys('KeyD')
    raf.step(10)
    const phaseA = engine.getPlayer().walkPhase
    raf.step(10)
    const phaseB = engine.getPlayer().walkPhase
    expect(phaseA).not.toBe(phaseB)
    // phase stays a normalised cycle
    expect(phaseB).toBeGreaterThanOrEqual(0)
    expect(phaseB).toBeLessThan(1)
    expect(STRIDE_LENGTH).toBeGreaterThan(10)
  })

  it('ignores keys while the user is typing in a field', () => {
    const input = globalThis.document.createElement('input')
    globalThis.document.body.appendChild(input)
    input.focus()

    startEngine()
    raf.step(1)
    const before = engine.getPlayer().x
    holdKeys('KeyD')
    raf.step(30)
    expect(engine.getPlayer().x).toBe(before)

    input.remove()
  })

  it('ignores key presses with a browser shortcut modifier', () => {
    startEngine()
    raf.step(1)
    const before = engine.getPlayer().x
    const event = new globalThis.window.KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true })
    globalThis.window.dispatchEvent(event)
    raf.step(20)
    expect(engine.getPlayer().x).toBe(before)
  })

  it('clears held keys on window blur so nothing sticks', () => {
    startEngine()
    raf.step(1)
    holdKeys('KeyD')
    raf.step(10)
    globalThis.window.dispatchEvent(new globalThis.window.Event('blur'))
    const movingAfterBlur = engine.getPlayer().moving
    raf.step(30)
    expect(movingAfterBlur === true || engine.getPlayer().moving === false).toBe(true)
    expect(engine.getPlayer().moving).toBe(false)
  })
})

describe('collision in the real office', () => {
  it('cannot walk through the reception desk', () => {
    startEngine()
    // Reception desk occupies x 1120..1440, y 1285..1375 — stand above it and push down.
    engine.getPlayer().x = 1280
    engine.getPlayer().y = 1200
    engine.getCamera().setViewport(1024, 640)
    raf.step(1)
    holdKeys('KeyS')
    raf.step(120)
    const player = engine.getPlayer()
    expect(player.y).toBeLessThan(1285 - AVATAR_RADIUS + 1)
    expect(circleHitsAny(player.x, player.y, AVATAR_RADIUS, STATIC_COLLIDERS)).toBeNull()
  })

  it('keeps the avatar inside the world bounds', () => {
    startEngine()
    raf.step(1)
    engine.getPlayer().x = 100
    engine.getPlayer().y = 100
    holdKeys('KeyW', 'KeyA')
    raf.step(200)
    const player = engine.getPlayer()
    expect(player.x).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.x + AVATAR_RADIUS - 0.5)
    expect(player.y).toBeGreaterThanOrEqual(WALKABLE_BOUNDS.y + AVATAR_RADIUS - 0.5)
  })

  it('never ends a frame inside solid geometry during a long random walk', () => {
    startEngine()
    raf.step(1)
    const sequences = [
      ['KeyD', 'KeyS'],
      ['KeyS', 'KeyA'],
      ['KeyA', 'KeyW'],
      ['KeyW', 'KeyD'],
      ['KeyD'],
      ['KeyS'],
    ]
    for (const keys of sequences) {
      releaseKeys('KeyW', 'KeyA', 'KeyS', 'KeyD')
      holdKeys(...keys)
      for (let i = 0; i < 40; i += 1) {
        raf.step(1)
        const player = engine.getPlayer()
        expect(
          circleHitsAny(player.x, player.y, AVATAR_RADIUS, STATIC_COLLIDERS),
          `stuck in furniture at ${player.x},${player.y}`,
        ).toBeNull()
      }
    }
  })

  it('walks a real route from the entrance to the open workspace', () => {
    startEngine()
    raf.step(1)
    engine.getPlayer().x = 1280
    engine.getPlayer().y = 1500

    const walkUntil = (predicate, key, label) => {
      holdKeys(key)
      let frames = 0
      while (!predicate(engine.getPlayer()) && frames < 1200) {
        raf.step(1)
        frames += 1
      }
      releaseKeys(key)
      raf.step(20) // let the velocity settle
      expect(predicate(engine.getPlayer()), `blocked while ${label}: stopped at ${engine.getPlayer().x},${engine.getPlayer().y}`).toBe(true)
    }

    // The reception desk (x 1120..1440) sits between the doors and the lobby, so a
    // real visitor steps around it — exactly what a player does.
    expect(engine.getPlayer().x).toBeGreaterThan(1120)
    // A real visitor walks around the reception desk (x 1120..1440), through the
    // lobby archway (x 965..1405), then west into the desk aisle (x ≈ 940, between
    // the 680..840 and 1000..1160 desk pods) and north into the workspace.
    walkUntil((p) => p.x < 1035, 'KeyA', 'stepping west around the reception desk')
    walkUntil((p) => p.y < 1040, 'KeyW', 'walking north through the lobby archway')
    walkUntil((p) => p.x < 945, 'KeyA', 'entering the workspace desk aisle')
    walkUntil((p) => p.y < 800, 'KeyW', 'crossing the open workspace')

    const player = engine.getPlayer()
    const zone = ZONES.find((z) => player.x >= z.x && player.x <= z.x + z.w && player.y >= z.y && player.y <= z.y + z.h)
    expect(zone?.id).toBe('workspace')
    expect(circleHitsAny(player.x, player.y, AVATAR_RADIUS, STATIC_COLLIDERS)).toBeNull()
  })
})

describe('camera integration', () => {
  it('follows the player by default and stops following after a pan', () => {
    startEngine()
    raf.step(1)
    expect(engine.getDiagnostics().camera.follow).toBe(true)

    canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 500, clientY: 300 })
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 400, clientY: 250 })
    canvas.dispatch('pointerup', { pointerId: 1 })
    expect(engine.getDiagnostics().camera.follow).toBe(false)
  })

  it('zooms with the wheel and with the keyboard', () => {
    startEngine()
    raf.step(1)
    canvas.dispatch('wheel', { deltaY: -400, clientX: 500, clientY: 300, preventDefault() {} })
    engine.zoomIn()
    for (let i = 0; i < 90; i += 1) raf.step(1)
    expect(engine.getCamera().zoom).toBeGreaterThan(1)

    engine.zoomOut()
    engine.zoomOut()
    for (let i = 0; i < 150; i += 1) raf.step(1)
    expect(engine.getCamera().zoom).toBeLessThan(2)
  })

  it('resets the camera with the R key and re-enables follow', () => {
    startEngine()
    raf.step(1)
    engine.zoomIn()
    canvas.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 500, clientY: 300 })
    canvas.dispatch('pointermove', { pointerId: 2, clientX: 300, clientY: 100 })
    canvas.dispatch('pointerup', { pointerId: 2 })
    expect(engine.getCamera().follow).toBe(false)

    tapKey('KeyR')
    const camera = engine.getCamera()
    expect(camera.zoom).toBe(1)
    expect(camera.follow).toBe(true)
  })

  it('teleports to each spawn point', () => {
    startEngine()
    raf.step(1)
    for (const spawn of SPAWNS) {
      expect(engine.teleportTo(spawn.id)).toBe(true)
      expect(engine.getPlayer().x).toBeCloseTo(spawn.x, 6)
      expect(engine.getPlayer().y).toBeCloseTo(spawn.y, 6)
    }
    expect(engine.teleportTo('nowhere')).toBe(false)
  })

  it('toggles labels with the L key', () => {
    startEngine()
    raf.step(1)
    expect(engine.getDiagnostics().showLabels).toBe(true)
    tapKey('KeyL')
    expect(engine.getDiagnostics().showLabels).toBe(false)
    tapKey('KeyL')
    expect(engine.getDiagnostics().showLabels).toBe(true)
  })
})

describe('canvas sizing', () => {
  it('sizes the backing store by CSS size × device pixel ratio', () => {
    globalThis.devicePixelRatio = 2
    startEngine()
    expect(canvas.width).toBe(2048)
    expect(canvas.height).toBe(1280)
    expect(canvas.style.width).toBe('1024px')
    expect(engine.getDiagnostics().viewport).toEqual({ width: 1024, height: 640, dpr: 2 })
  })

  it('caps the pixel ratio to keep the fill rate sane', () => {
    globalThis.devicePixelRatio = 3
    startEngine()
    expect(engine.getDiagnostics().viewport.dpr).toBe(2)
  })

  it('re-measures on window resize', () => {
    startEngine()
    container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 })
    globalThis.window.dispatchEvent(new globalThis.window.Event('resize'))
    expect(canvas.width).toBe(1600)
    expect(engine.getDiagnostics().viewport.width).toBe(1600)
    expect(engine.getDiagnostics().viewport.height).toBe(900)
  })
})

describe('HUD store throttling', () => {
  it('writes to the store at ~5 Hz, not once per frame', () => {
    startEngine()
    const baseline = store.writes.length
    raf.step(120, 16) // ~1.9 seconds of frames
    const writes = store.writes.length - baseline
    expect(writes).toBeGreaterThan(5) // it does update
    expect(writes).toBeLessThanOrEqual(12) // but not 120 times
  })

  it('publishes the room the player stands in', () => {
    startEngine()
    raf.step(1)
    expect(store.getSnapshot().zoneName).toBe('Reception & Entrance')
    engine.teleportTo('workspace')
    expect(store.getSnapshot().zoneName).toBe('Open Workspace')
    engine.teleportTo('meeting')
    expect(store.getSnapshot().zoneName).toBe('Meeting Room')
  })

  it('publishes camera state for the controls', () => {
    startEngine()
    raf.step(1)
    const snapshot = store.getSnapshot()
    expect(snapshot.zoom).toBe(1)
    expect(snapshot.follow).toBe(true)
    expect(snapshot.showLabels).toBe(true)
    expect(snapshot.engineReady).toBe(true)
  })
})

describe('peers (network-ready rendering path)', () => {
  it('renders injected peers and reports them in the HUD', () => {
    startEngine()
    raf.step(1)
    const count = engine.setPeers([
      { id: 'p1', name: 'Priya', x: 1100, y: 1200, facing: 0, nearby: true, distance: 180 },
      { id: 'p2', name: 'Ravi', x: 1300, y: 900 },
    ])
    expect(count).toBe(2)
    expect(engine.getPeers()).toHaveLength(2)
    raf.step(2)
    const snapshot = store.getSnapshot()
    expect(snapshot.peerCount).toBe(2)
    expect(snapshot.nearbyCount).toBe(1)
  })

  it('updates and removes peers incrementally', () => {
    startEngine()
    engine.setPeers([{ id: 'p1', name: 'Priya', x: 1100, y: 1200 }])
    engine.upsertPeer({ id: 'p1', speaking: true, nearby: true })
    const peer = engine.getPeers()[0]
    expect(peer.speaking).toBe(true)
    expect(peer.nearby).toBe(true)
    expect(peer.name).toBe('Priya') // untouched fields survive the patch

    expect(engine.removePeer('p1')).toBe(true)
    expect(engine.removePeer('p1')).toBe(false)
    expect(engine.getPeers()).toHaveLength(0)
  })

  it('gives each peer a deterministic appearance when none is supplied', () => {
    startEngine()
    const first = engine.upsertPeer({ id: 'peer-x', x: 100, y: 100 }).appearance
    engine.setPeers([])
    const second = engine.upsertPeer({ id: 'peer-x', x: 100, y: 100 }).appearance
    expect(second).toEqual(first)
  })

  it('clears peers on destroy', () => {
    startEngine()
    engine.setPeers([{ id: 'p1' }])
    engine.destroy()
    expect(engine.getPeers()).toHaveLength(0)
    expect(store.getSnapshot().peerCount).toBe(0)
  })
})
