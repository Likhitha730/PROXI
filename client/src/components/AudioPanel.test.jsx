/**
 * Audio panel tests.
 *
 * The acceptance criteria that live in the UI are asserted here: the microphone is
 * only ever requested from the button (never on mount), the permission/error status
 * is visible, mute is reachable, and speaking/connection state is readable without
 * relying on colour alone.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AudioPanel } from './AudioPanel.jsx'
import { MIC_STATE } from '../audio/audioEngine.js'
import { LIMITS } from '../../../shared/protocol.js'

const CONNECTED = { status: 'connected', socketId: 'socket-1' }
const OFFLINE = { status: 'error', socketId: null }

let container
let root

/** A stand-in for the audio engine API the panel is handed by App. */
function createAudioStub(overrides = {}) {
  return {
    mic: MIC_STATE.IDLE,
    micError: null,
    muted: false,
    enabled: false,
    error: null,
    hasTurn: null,
    iceSource: null,
    peers: [],
    enable: vi.fn(),
    disable: vi.fn(),
    toggleMute: vi.fn(),
    ...overrides,
  }
}

function mount(ui) {
  container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(ui))
}

function rerender(ui) {
  act(() => root.render(ui))
}

const text = () => container.textContent

beforeEach(() => {
  container = null
  root = null
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.restoreAllMocks()
})

describe('AudioPanel', () => {
  it('does not ask for the microphone when it mounts', () => {
    const audio = createAudioStub()

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(audio.enable).not.toHaveBeenCalled()
    expect(audio.disable).not.toHaveBeenCalled()
    expect(text()).toContain('Microphone off')
  })

  it('asks for the microphone only when the button is pressed', () => {
    const audio = createAudioStub()
    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    const button = container.querySelector('[data-testid="mic-toggle"]')
    expect(button.disabled).toBe(false)
    act(() => button.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })))

    expect(audio.enable).toHaveBeenCalledTimes(1)
  })

  it('cannot enable the microphone while the socket is down', () => {
    const audio = createAudioStub()

    mount(<AudioPanel audio={audio} connection={OFFLINE} />)

    const button = container.querySelector('[data-testid="mic-toggle"]')
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Enable microphone')
  })

  it('shows that a permission prompt is open, and disables the button while waiting', () => {
    const audio = createAudioStub({ mic: MIC_STATE.REQUESTING })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(text()).toContain('Waiting for microphone permission')
    expect(container.querySelector('[data-testid="mic-toggle"]').disabled).toBe(true)
  })

  it('surfaces a denied permission with an explanation', () => {
    const audio = createAudioStub({ mic: MIC_STATE.DENIED, micError: 'Microphone permission was denied.' })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    const error = container.querySelector('[data-testid="mic-error"]')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toMatch(/permission was denied/i)
    expect(text()).toContain('Microphone unavailable')
  })

  it('makes an active microphone unmistakable, and mute reachable', () => {
    const audio = createAudioStub({ mic: MIC_STATE.ACTIVE, enabled: true, muted: false })
    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(text()).toContain('Microphone active')
    const dot = container.querySelector('[data-testid="mic-status"] .audio__dot')
    expect(dot.className).toContain('audio__dot--live')

    const muteButton = container.querySelector('[data-testid="mute-toggle"]')
    expect(muteButton.disabled).toBe(false)
    act(() => muteButton.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })))
    expect(audio.toggleMute).toHaveBeenCalledTimes(1)
  })

  it('says plainly that a muted microphone is not being heard', () => {
    const audio = createAudioStub({ mic: MIC_STATE.ACTIVE, enabled: true, muted: true })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(text()).toContain('muted')
    expect(text()).toContain('Nobody can hear you')
    expect(container.querySelector('[data-testid="mute-toggle"]').textContent).toBe('Unmute')
  })

  it('turns the microphone off again from the same button', () => {
    const audio = createAudioStub({ mic: MIC_STATE.ACTIVE, enabled: true })
    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    act(() => container.querySelector('[data-testid="mic-toggle"]').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })))

    expect(audio.disable).toHaveBeenCalledTimes(1)
    expect(audio.enable).not.toHaveBeenCalled()
  })

  it('explains an idle state before any peer is in earshot', () => {
    mount(<AudioPanel audio={createAudioStub()} connection={CONNECTED} />)

    expect(container.querySelector('[data-testid="audio-summary"]').textContent).toContain('No voice connections')
    expect(text()).toContain(`listening radius ${LIMITS.PROXIMITY_RADIUS} u`)
  })

  it('lists each voice connection with its own state and speaking indicator', () => {
    const audio = createAudioStub({
      mic: MIC_STATE.ACTIVE,
      enabled: true,
      peers: [
        { id: 'p1', name: 'Ada', state: 'connected', speaking: true, muted: false },
        { id: 'p2', name: 'Grace', state: 'connecting', speaking: false, muted: false },
        { id: 'p3', name: 'Linus', state: 'connected', speaking: false, muted: true },
      ],
    })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(container.querySelector('[data-testid="audio-peer-state-p1"]').textContent).toBe('speaking')
    expect(container.querySelector('[data-testid="audio-peer-state-p2"]').textContent).toContain('connecting')
    expect(container.querySelector('[data-testid="audio-peer-muted-p3"]').textContent).toBe('muted')
    expect(container.querySelector('[data-testid="audio-peers"]').querySelectorAll('li')).toHaveLength(3)
    expect(container.querySelector('[data-testid="audio-summary"]').textContent).toContain('3 voice connections')
    expect(container.querySelector('[data-testid="audio-summary"]').textContent).toContain('1 speaking')
    expect(container.querySelector('[data-testid="audio-summary"]').textContent).toContain('1 connecting')
  })

  it('names an unknown peer neutrally rather than showing a blank row', () => {
    const audio = createAudioStub({ peers: [{ id: 'p1', name: null, state: 'connected', speaking: false, muted: false }] })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(text()).toContain('Someone nearby')
  })

  it('reports failed connections and points at TURN only when no relay is configured', () => {
    const failed = [{ id: 'p1', name: 'Ada', state: 'failed', speaking: false, muted: false }]

    mount(<AudioPanel audio={createAudioStub({ peers: failed, hasTurn: false })} connection={CONNECTED} />)
    expect(container.querySelector('[data-testid="audio-failed"]').textContent).toMatch(/no TURN relay is configured/i)

    rerender(<AudioPanel audio={createAudioStub({ peers: failed, hasTurn: true })} connection={CONNECTED} />)
    const message = container.querySelector('[data-testid="audio-failed"]').textContent
    expect(container.querySelector('[data-testid="audio-failed"]')).toBeTruthy()
    expect(message).not.toMatch(/no TURN relay is configured/i)
    expect(message).toMatch(/1 voice connection failed/i)
  })

  it('reports a browser that cannot do WebRTC at all', () => {
    const audio = createAudioStub({ mic: MIC_STATE.ACTIVE, enabled: true, error: 'This browser does not support WebRTC (RTCPeerConnection is missing).' })

    mount(<AudioPanel audio={audio} connection={CONNECTED} />)

    expect(text()).toContain('does not support WebRTC')
  })

  it('renders safely before the engine has produced a snapshot', () => {
    mount(<AudioPanel audio={undefined} connection={undefined} />)

    expect(container.querySelector('[data-testid="audio-panel"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="mic-toggle"]').disabled).toBe(true)
  })
})
