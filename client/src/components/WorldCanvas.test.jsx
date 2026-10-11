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
import { presence } from '../net/presence.js'

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
  presence.reset()
  globalThis.devicePixelRatio = 1
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  presence.reset()
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

describe('remote players reach the canvas', () => {
  /** Feed the presence singleton exactly as socketClient does on the wire. */
  function applySnapshotWithPeer() {
    presence.applySnapshot({
      self: { id: 'self-1', name: 'You', x: 1280, y: 1500, dir: Math.PI / 2, moving: false },
      players: [{ id: 'peer-1', name: 'Ada', x: 900, y: 800, dir: 0, moving: false }],
      room: { id: 'proxispeak-lobby', maxPlayers: 24 },
    })
  }

  it('renders a remote avatar as soon as the roster arrives', () => {
    mountWorld()
    act(() => raf.step(1))
    expect(engineRef.current.getPeers()).toHaveLength(0)

    act(() => applySnapshotWithPeer())
    act(() => raf.step(1))

    const peers = engineRef.current.getPeers()
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ id: 'peer-1', name: 'Ada', isLocal: false })
    expect(peers[0].appearance).toBeTruthy()
  })

  it('moves the remote avatar smoothly between 15 Hz network updates', () => {
    mountWorld()
    act(() => applySnapshotWithPeer())
    act(() => raf.step(1))

    // Three network samples, 66 ms apart, walking east at ~205 u/s.
    const positions = []
    for (let i = 1; i <= 3; i += 1) {
      act(() => {
        presence.applyMove({ id: 'peer-1', x: 900 + i * 13.7, y: 800, dir: 0, moving: true })
        raf.step(4) // ~66 ms of animation frames per network sample
      })
      positions.push(engineRef.current.getPeers()[0].x)
    }

    // Every frame produced a distinct, monotonically advancing position: the
    // avatar glides instead of jumping once per network packet.
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])

    const avatar = engineRef.current.getPeers()[0]
    expect(avatar.walkPhase).toBeGreaterThan(0) // walk cycle advanced by real travel
  })

  it('removes the avatar when the player leaves', () => {
    mountWorld()
    act(() => applySnapshotWithPeer())
    act(() => raf.step(2))
    expect(engineRef.current.getPeers()).toHaveLength(1)

    act(() => presence.applyLeft({ id: 'peer-1' }))
    act(() => raf.step(1))
    expect(engineRef.current.getPeers()).toHaveLength(0)
  })

  it('snaps the local avatar to the server position after a rejected move', () => {
    mountWorld()
    act(() => raf.step(2))
    const player = engineRef.current.getPlayer()
    player.x = 1280
    player.y = 1500

    act(() => {
      presence.applyError({ code: 'invalid_position', message: 'position rejected', data: { x: 1200, y: 1440 } })
      raf.step(1)
    })

    expect(player.x).toBe(1200)
    expect(player.y).toBe(1440)
  })

  it('publishes local movement through the socket layer', () => {
    mountWorld()
    act(() => raf.step(1))
    // Without a live socket sendMove() reports false; the engine must not care.
    pressKey('KeyD')
    act(() => raf.step(30))
    pressKey('KeyD', { type: 'keyup' })
    expect(engineRef.current.getDiagnostics().reportedMoves).toBeGreaterThan(0)
    expect(engineRef.current.getDiagnostics().hasStateReporter).toBe(true)
  })
})
