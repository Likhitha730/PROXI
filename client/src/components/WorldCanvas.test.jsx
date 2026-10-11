/**
 * Component-level lifecycle test.
 *
 * This is the explicit quality check from the milestone: the animation loop must
 * be cleaned up when the component unmounts. It mounts the real <WorldCanvas />,
 * runs frames through a fake rAF, unmounts, and then proves that nothing keeps
 * ticking and no listener still reacts to input.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeContext, installFakeRaf, pressKey } from '../test/fakeCanvas.js'
import { WorldCanvas } from './WorldCanvas.jsx'
import { worldStore } from '../state/worldStore.js'

let raf
let container
let root
let engineRef

function mountWorld(props = {}) {
  container = globalThis.document.createElement('div')
  container.style.width = '1024px'
  container.style.height = '640px'
  globalThis.document.body.appendChild(container)

  // jsdom has no canvas implementation: hand it a recording context.
  const context = createFakeContext({ width: 1024, height: 640 })
  globalThis.HTMLCanvasElement.prototype.getContext = vi.fn(() => context)
  globalThis.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1024,
    height: 640,
    right: 1024,
    bottom: 640,
  })

  root = createRoot(container)
  engineRef = { current: null }
  act(() => {
    root.render(
      <WorldCanvas
        spawnId="entrance"
        playerName="You"
        onEngineReady={(engine) => {
          engineRef.current = engine
        }}
        {...props}
      />,
    )
  })
  return context
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
})

describe('WorldCanvas', () => {
  it('mounts a canvas into the stage host and starts the engine', () => {
    mountWorld()
    const canvasElement = globalThis.document.querySelector('[data-testid="world-canvas"]')
    expect(canvasElement).not.toBeNull()
    expect(engineRef.current).toBeTruthy()

    act(() => raf.step(2))
    expect(engineRef.current.getDiagnostics().running).toBe(true)
    expect(engineRef.current.getDiagnostics().frames).toBeGreaterThan(0)
  })

  it('publishes world state through the store for the HUD', () => {
    mountWorld()
    act(() => raf.step(2))
    const snapshot = worldStore.getSnapshot()
    expect(snapshot.engineReady).toBe(true)
    expect(snapshot.running).toBe(true)
    expect(snapshot.zoneName).toBe('Reception & Entrance')
  })

  it('responds to keyboard input while mounted', () => {
    mountWorld()
    act(() => raf.step(1))
    const startX = engineRef.current.getPlayer().x
    pressKey('KeyD')
    act(() => raf.step(20))
    expect(engineRef.current.getPlayer().x).toBeGreaterThan(startX)
    pressKey('KeyD', { type: 'keyup' })
  })

  it('cleans up the animation loop and listeners on unmount', () => {
    mountWorld()
    act(() => raf.step(3))
    const engine = engineRef.current
    const player = engine.getPlayer()
    const positionBeforeUnmount = { x: player.x, y: player.y }

    act(() => root.unmount())
    root = null

    // loop stopped: no frame pending, nothing scheduled to run
    expect(raf.hasPendingFrame).toBe(false)
    expect(engine.getDiagnostics().running).toBe(false)
    expect(engine.getDiagnostics().keyboardAttached).toBe(false)

    // no listeners left on the canvas element
    const framesBefore = engine.getDiagnostics().frames
    pressKey('KeyD')
    raf.step(10)
    expect(engine.getDiagnostics().frames).toBe(framesBefore)
    expect({ x: player.x, y: player.y }).toEqual(positionBeforeUnmount)

    // the store reports the engine as stopped
    expect(worldStore.getSnapshot().running).toBe(false)
  })

  it('survives a renderer failure without breaking the page', () => {
    globalThis.HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
    container = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(container)
    root = createRoot(container)
    expect(() => {
      act(() => {
        root.render(<WorldCanvas playerName="You" spawnId="entrance" />)
      })
    }).not.toThrow()
    expect(container.querySelector('[data-testid="world-canvas"]')).not.toBeNull()
  })
})
