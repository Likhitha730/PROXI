/**
 * Presence panel tests.
 *
 * Two things matter here beyond rendering: applying a display name goes through
 * the network layer, and typing in the name field must never move the avatar —
 * the panel and the canvas share a keyboard.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeContext, installFakeRaf, pressKey } from '../test/fakeCanvas.js'
import { PresencePanel } from './PresencePanel.jsx'
import { Workspace } from './Workspace.jsx'
import { createPresence } from '../net/presence.js'
import { worldStore } from '../state/worldStore.js'
import { getDisplayName } from '../net/socketClient.js'

const CONNECTION = { status: 'connected', socketId: 'socket-1', transport: 'websocket', connectedAt: Date.now(), attempts: 1 }
const HEALTH = { status: 'ok', data: { status: 'ok', service: 'proxispeak-server', version: '0.1.0', uptimeSeconds: 4, database: { status: 'disabled' } } }

let container
let root
let raf
let presence

function buildPresence({ peers = [], self = { id: 'self-1', name: 'Me', x: 1280, y: 1500 }, nearby = [] } = {}) {
  const instance = createPresence({ now: () => 0 })
  instance.applySnapshot({
    self,
    players: peers.map((name, index) => ({ id: `peer-${index}`, name, x: 900, y: 800, dir: 0, moving: false })),
    room: { id: 'proxispeak-lobby', maxPlayers: 24 },
  })
  if (nearby.length > 0) {
    instance.applyProximity({
      id: self.id,
      radius: 100,
      at: Date.now(),
      neighbours: nearby.map(({ id, name, distance }) => ({ id, name, x: 900, y: 800, distance, nearby: true })),
    })
  }
  return instance
}

function mount(ui) {
  container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(ui))
}

beforeEach(() => {
  raf = installFakeRaf()
  worldStore.reset()
  globalThis.devicePixelRatio = 1
  globalThis.HTMLCanvasElement.prototype.getContext = vi.fn(() => createFakeContext({ width: 1024, height: 640 }))
  globalThis.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 640, right: 1024, bottom: 640 })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  raf.restore()
  delete globalThis.HTMLElement.prototype.getBoundingClientRect
  vi.restoreAllMocks()
})

describe('PresencePanel', () => {
  it('shows the connected-player count, the room and the roster', () => {
    presence = buildPresence({ peers: ['Ada', 'Grace'] })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)

    expect(container.querySelector('[data-testid="presence-count"]').textContent).toContain('3')
    expect(container.querySelector('[data-testid="presence-count"]').textContent).toContain('proxispeak-lobby')
    const roster = container.querySelector('[data-testid="presence-roster"]').textContent
    expect(roster).toContain('Ada')
    expect(roster).toContain('Grace')
  })

  it('explains the empty state instead of showing a blank list', () => {
    presence = buildPresence({ peers: [] })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)
    expect(container.querySelector('[data-testid="presence-roster"]').textContent).toMatch(/no one else here/i)
    expect(container.querySelector('[data-testid="presence-count"]').textContent).toContain('1')
  })

  it('applies a new display name through the network layer', () => {
    presence = buildPresence()
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)

    const input = container.querySelector('[data-testid="display-name-input"]')
    const applyButton = container.querySelector('[data-testid="display-name-apply"]')
    const form = input.closest('form')
    const originalName = input.value
    expect(applyButton.disabled).toBe(true) // nothing to apply yet

    // Type like a browser does: native value setter + input event.
    const nativeSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value').set
    act(() => {
      nativeSetter.call(input, 'Ada Lovelace')
      input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
    })
    expect(applyButton.disabled).toBe(false)
    expect(input.value).toBe('Ada Lovelace')
    expect(input.value).not.toBe(originalName)

    act(() => {
      form.dispatchEvent(new globalThis.window.Event('submit', { bubbles: true, cancelable: true }))
    })

    // the network layer took the name and remembered it for the next visit
    expect(getDisplayName()).toBe('Ada Lovelace')
    expect(globalThis.localStorage.getItem('proxispeak.displayName')).toBe('Ada Lovelace')
    expect(input.value).toBe('Ada Lovelace')
  })

  it('shows nearby users with the distance the server measured', () => {
    presence = buildPresence({
      peers: ['Ada', 'Grace'],
      nearby: [
        { id: 'peer-1', name: 'Grace', distance: 42.4 },
        { id: 'peer-0', name: 'Ada', distance: 12 },
      ],
    })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)

    const list = container.querySelector('[data-testid="presence-nearby"]')
    // nearest first, distances rounded for the eye
    expect(list.textContent).toContain('Ada')
    expect(list.textContent).toContain('12 u')
    expect(list.textContent).toContain('42 u')
    expect(list.textContent.indexOf('Ada')).toBeLessThan(list.textContent.indexOf('Grace'))
    // the radius in force is stated, so "nearby" is never a mystery number
    expect(container.querySelector('[data-testid="presence-nearby-block"]').textContent).toContain('within 100 u')
  })

  it('marks roster entries that are inside the radius', () => {
    presence = buildPresence({ peers: ['Ada', 'Grace'], nearby: [{ id: 'peer-1', name: 'Grace', distance: 30 }] })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)

    const items = [...container.querySelectorAll('[data-testid="presence-roster"] .presence__item')]
    expect(items).toHaveLength(2)
    expect(items[1].querySelector('.presence__dot--nearby')).not.toBeNull() // Grace
    expect(items[0].querySelector('.presence__dot--nearby')).toBeNull() // Ada
  })

  it('explains an empty nearby list', () => {
    presence = buildPresence({ peers: ['Ada'] })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} />)
    expect(container.querySelector('[data-testid="presence-nearby"]').textContent).toMatch(/nobody within earshot/i)

    presence = buildPresence({ peers: ['Ada'] })
    mount(<PresencePanel presence={presence.getSnapshot()} connection={{ ...CONNECTION, status: 'error' }} />)
    expect(container.querySelector('[data-testid="presence-nearby"]').textContent).toMatch(/offline/i)
  })

  it('renders a server error with a dismiss action', () => {
    presence = buildPresence()
    presence.applyError({ code: 'rate_limited', message: 'Movement updates are limited to 15 per second.' })
    const dismiss = vi.fn()
    mount(<PresencePanel presence={presence.getSnapshot()} connection={CONNECTION} onDismissError={dismiss} />)

    const error = container.querySelector('[data-testid="presence-error"]')
    expect(error.textContent).toMatch(/15 per second/)

    act(() => {
      error.querySelector('button').dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
    })
    expect(dismiss).toHaveBeenCalled()
  })

  it('disables the apply button while disconnected', () => {
    presence = buildPresence()
    mount(<PresencePanel presence={presence.getSnapshot()} connection={{ status: 'connecting' }} />)
    expect(container.querySelector('[data-testid="display-name-apply"]').disabled).toBe(true)
  })
})

describe('typing in the presence panel does not move the avatar', () => {
  it('keeps the canvas idle while the name field has focus', async () => {
    presence = buildPresence()
    let engine = null
    mount(
      <Workspace
        connection={CONNECTION}
        health={HEALTH}
        world={worldStore.getSnapshot()}
        presence={presence.getSnapshot()}
        onEngineReady={(instance) => {
          if (instance) engine = instance
        }}
      />,
    )
    act(() => raf.step(2))

    const input = container.querySelector('[data-testid="display-name-input"]')
    input.focus()
    expect(globalThis.document.activeElement).toBe(input)

    const before = { x: engine.getPlayer().x, y: engine.getPlayer().y }
    act(() => {
      for (const code of ['KeyD', 'KeyS', 'ArrowRight', 'ArrowDown']) pressKey(code, { target: input })
      raf.step(30)
    })

    expect({ x: engine.getPlayer().x, y: engine.getPlayer().y }).toEqual(before)

    // and movement resumes once the field loses focus
    input.blur()
    act(() => {
      pressKey('KeyD', { target: globalThis.document.body })
      raf.step(30)
      pressKey('KeyD', { type: 'keyup' })
    })
    expect(engine.getPlayer().x).toBeGreaterThan(before.x)
  })

  it('shows the live count in the stage header and the HUD', () => {
    presence = buildPresence({ peers: ['Ada'] })
    mount(
      <Workspace
        connection={CONNECTION}
        health={HEALTH}
        world={worldStore.getSnapshot()}
        presence={presence.getSnapshot()}
      />,
    )
    act(() => raf.step(2))

    expect(container.querySelector('[data-testid="stage-player-count"]').textContent).toContain('2 players online')
    expect(container.querySelector('[data-testid="presence-roster"]').textContent).toContain('Ada')
  })
})
