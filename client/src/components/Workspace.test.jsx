/**
 * Workspace integration test.
 *
 * Covers the two acceptance criteria that are about behaviour rather than pixels:
 *   * React must not re-render every frame (the animation loop is independent of
 *     the component tree and only publishes coarse state at ~5 Hz),
 *   * the camera controls must actually drive the engine (buttons and shortcuts
 *     share one code path).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeContext, installFakeRaf, pressKey } from '../test/fakeCanvas.js'
import { Workspace } from './Workspace.jsx'
import { worldStore } from '../state/worldStore.js'

let raf
let container
let root
let engines

const CONNECTION = { status: 'connected', socketId: 'socket-1', transport: 'websocket', connectedAt: Date.now(), attempts: 1 }
const HEALTH = { status: 'ok', data: { status: 'ok', service: 'proxispeak-server', version: '0.2.0', uptimeSeconds: 12, database: { status: 'not-configured' } } }

function mountWorkspace() {
  engines = []
  container = globalThis.document.createElement('div')
  container.style.width = '1280px'
  container.style.height = '800px'
  globalThis.document.body.appendChild(container)

  const context = createFakeContext({ width: 1280, height: 800 })
  globalThis.HTMLCanvasElement.prototype.getContext = vi.fn(() => context)
  globalThis.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 })

  root = createRoot(container)
  act(() => renderTree())
  return engines[engines.length - 1]
}

function captureEngine(engine) {
  engines.push(engine)
}

/** Renders served to the tree across every frame under test. */
let probeRenders = 0

/**
 * Render counter. It is always part of the tree (including the store-driven
 * re-renders) so counting its renders measures how often React actually works.
 */
function Probe() {
  probeRenders += 1
  return null
}

function readEngine() {
  return engines[engines.length - 1]
}

function renderTree() {
  root.render(
    <>
      <Workspace
        connection={CONNECTION}
        health={HEALTH}
        world={worldStore.getSnapshot()}
        onEngineReady={captureEngine}
      />
      <Probe />
    </>,
  )
}

function renderWithStoreSync() {
  // Re-render the tree whenever the store publishes, mirroring hooks.useWorldState.
  return worldStore.subscribe(() => {
    act(() => renderTree())
  })
}

function byLabel(label) {
  return container.querySelector(`[aria-label="${label}"]`)
}

function click(element) {
  act(() => {
    element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  raf = installFakeRaf()
  worldStore.reset()
  globalThis.devicePixelRatio = 1
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  raf.restore()
  delete globalThis.HTMLElement.prototype.getBoundingClientRect
  vi.restoreAllMocks()
})

describe('Workspace', () => {
  it('renders the stage, the camera toolbar and the HUD panels', () => {
    mountWorkspace()
    act(() => raf.step(2))

    expect(container.querySelector('[data-testid="world-canvas"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="world-canvas-host"]')).not.toBeNull()
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="world-zone"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="world-position"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="connection-state"]').textContent).toBe('connected')
    expect(container.querySelector('[data-testid="socket-id"]').textContent).toBe('socket-1')
    expect(container.querySelector('[data-testid="transport"]').textContent).toBe('websocket')
  })

  it('offers every documented camera control as a real button', () => {
    mountWorkspace()
    const toolbar = container.querySelector('[role="toolbar"]')
    const labels = [...toolbar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent.trim())
    expect(labels).toEqual(
      expect.arrayContaining(['Zoom out', 'Zoom in', 'Reset camera', 'Follow the player', 'Show room labels']),
    )
    for (const button of toolbar.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label') || button.textContent.trim()).toBeTruthy()
    }
  })

  it('drives zoom, camera reset and follow from the buttons', () => {
    const engine = mountWorkspace()
    act(() => raf.step(2))

    const zoomStart = engine.getCamera().zoom
    click(byLabel('Zoom in'))
    // Zoom is damped toward its target: the request lands immediately, the value eases.
    expect(engine.getCamera().targetZoom).toBeGreaterThan(zoomStart)
    act(() => raf.step(60))
    expect(engine.getCamera().zoom).toBeGreaterThan(zoomStart)
    expect(engine.getCamera().zoom).toBeCloseTo(engine.getCamera().targetZoom, 2)

    click(byLabel('Zoom out'))
    click(byLabel('Zoom out'))
    expect(engine.getCamera().targetZoom).toBeLessThan(zoomStart)

    click(byLabel('Reset camera'))
    const camera = engine.getCamera()
    expect(camera.zoom).toBe(1)
    expect(camera.targetZoom).toBe(1)
    expect(camera.follow).toBe(true)

    click(byLabel('Follow the player'))
    expect(engine.getCamera().follow).toBe(false)
    click(byLabel('Show room labels'))
    expect(engine.getDiagnostics().showLabels).toBe(false)
  })

  it('clamps zoom to the documented range from the buttons', () => {
    const engine = mountWorkspace()
    act(() => raf.step(2))
    for (let i = 0; i < 30; i += 1) click(byLabel('Zoom in'))
    expect(engine.getCamera().targetZoom).toBeLessThanOrEqual(2)
    for (let i = 0; i < 60; i += 1) click(byLabel('Zoom out'))
    expect(engine.getCamera().targetZoom).toBeGreaterThanOrEqual(0.5)
  })

  it('teleports from the spawn chips', () => {
    const engine = mountWorkspace()
    act(() => raf.step(2))
    const chips = [...container.querySelectorAll('.chip-button')]
    expect(chips.length).toBeGreaterThanOrEqual(3)
    click(chips[0])
    const player = engine.getPlayer()
    expect(Number.isFinite(player.x) && Number.isFinite(player.y)).toBe(true)
    expect(engine.getDiagnostics().spawnId).toBeTruthy()
  })

  it('publishes HUD state at ~5 Hz, never once per frame', () => {
    mountWorkspace()
    act(() => raf.step(2))

    const publishTimes = []
    const unsubscribe = worldStore.subscribe(() => publishTimes.push(raf.now))
    pressKey('KeyD')
    act(() => raf.step(300))
    pressKey('KeyD', { type: 'keyup' })
    unsubscribe()

    const engine = readEngine()
    const diagnostics = engine.getDiagnostics()
    expect(diagnostics.frames).toBeGreaterThanOrEqual(300)
    expect(diagnostics.player.x).toBeGreaterThan(1300) // the avatar really walked

    // 300 frames at 16 ms = 4.8 s of simulated time; the HUD samples that at 5 Hz.
    // A loop wired to React would publish 300 times here.
    expect(publishTimes.length).toBeGreaterThanOrEqual(20)
    expect(publishTimes.length).toBeLessThan(35)
    for (let i = 1; i < publishTimes.length; i += 1) {
      expect(publishTimes[i] - publishTimes[i - 1]).toBeGreaterThanOrEqual(190)
    }
  })

  it('re-renders the tree from the store without touching the frame loop', () => {
    mountWorkspace()
    act(() => raf.step(2))

    // React 18 batches updates inside act(), so this counts render passes, not
    // publishes: the point is that the tree does follow the store and that the
    // number of passes stays far below the number of frames.
    const unsubscribe = renderWithStoreSync()
    const before = probeRenders
    act(() => raf.step(120))
    unsubscribe()

    const painted = probeRenders - before
    expect(painted).toBeGreaterThanOrEqual(1)
    expect(painted).toBeLessThan(30)
    expect(readEngine().getDiagnostics().running).toBe(true)
  })

  it('stops the loop when the workspace unmounts', () => {
    const engine = mountWorkspace()
    act(() => raf.step(3))
    act(() => root.unmount())
    root = null
    expect(engine.getDiagnostics().running).toBe(false)
    expect(raf.hasPendingFrame).toBe(false)
  })
})
