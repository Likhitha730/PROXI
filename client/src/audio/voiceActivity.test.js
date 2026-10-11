/**
 * Voice activity detector tests.
 *
 * A fake AudioContext feeds the detector a programmable waveform, so the RMS
 * threshold and the hangover window can be exercised without a microphone. The
 * point of these tests is that the detector publishes **one boolean** and nothing
 * else — no samples, no levels, no audio content ever leave it.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVoiceDetector } from './voiceActivity.js'
import { LIMITS } from '../../../shared/protocol.js'

/** An AnalyserNode stand-in: every sample after `push(wave)` comes from the wave. */
function createFakeAnalyser() {
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    wave: new Float32Array(512),
    getFloatTimeDomainData(target) {
      for (let index = 0; index < target.length; index += 1) {
        target[index] = analyser.wave[index % analyser.wave.length] ?? 0
      }
    },
  }
  return analyser
}

function createFakeAudioContext(analyser) {
  const context = {
    analyser,
    closed: false,
    created: 0,
    connected: [],
    disconnected: [],
    createAnalyser() {
      return analyser
    },
    createMediaStreamSource() {
      context.created += 1
      return {
        connect: (node) => context.connected.push(node),
        disconnect: () => context.disconnected.push('source'),
      }
    },
    close() {
      context.closed = true
    },
  }
  return context
}

const LOUD = new Float32Array(512).fill(0.5)
const SILENT = new Float32Array(512).fill(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function build({ wave = SILENT } = {}) {
  const analyser = createFakeAnalyser()
  analyser.wave = wave
  const context = createFakeAudioContext(analyser)
  const events = []
  const detector = createVoiceDetector({ id: 'stream' }, (speaking) => events.push(speaking), {
    audioContextFactory: () => context,
    intervalMs: 50,
    hangMs: LIMITS.SPEAKING_HANG_MS,
  })
  return { detector, analyser, context, events }
}

describe('createVoiceDetector', () => {
  it('reports speaking once the level crosses the threshold, and stops after the hangover', () => {
    const { analyser, events } = build()

    analyser.wave = LOUD
    vi.advanceTimersByTime(50)
    expect(events).toEqual([true])

    // Silence, but still inside the hangover window: stay "speaking".
    analyser.wave = SILENT
    vi.advanceTimersByTime(100)
    expect(events).toEqual([true])

    // Past the hangover: one transition back to false, and only one.
    vi.advanceTimersByTime(LIMITS.SPEAKING_HANG_MS)
    vi.advanceTimersByTime(100)
    expect(events).toEqual([true, false])
  })

  it('does not fire repeatedly while the level stays high', () => {
    const { analyser, events } = build()
    analyser.wave = LOUD

    vi.advanceTimersByTime(1_000)

    expect(events).toEqual([true])
  })

  it('ignores noise below the threshold', () => {
    const { analyser, events } = build()
    analyser.wave = new Float32Array(512).fill(LIMITS.SPEAKING_RMS_THRESHOLD * 0.5)

    vi.advanceTimersByTime(1_000)

    expect(events).toEqual([])
  })

  it('supports the byte-only analyser API used by older browsers', () => {
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getByteTimeDomainData(target) {
        // 128 = silence, far from 128 = loud.
        target.fill(128 + 100)
      },
    }
    const context = createFakeAudioContext(analyser)
    const events = []
    const detector = createVoiceDetector({ id: 'stream' }, (speaking) => events.push(speaking), {
      audioContextFactory: () => context,
      intervalMs: 50,
    })

    vi.advanceTimersByTime(100)

    expect(events).toEqual([true])
    detector.stop()
  })

  it('exposes the current level for diagnostics', () => {
    const { detector, analyser } = build()
    analyser.wave = LOUD

    vi.advanceTimersByTime(50)

    expect(detector.level()).toBeCloseTo(0.5, 3)
  })

  it('stops sampling and emits a final false on stop()', () => {
    const { detector, analyser, context, events } = build()
    analyser.wave = LOUD
    vi.advanceTimersByTime(50)

    detector.stop()
    analyser.wave = SILENT
    vi.advanceTimersByTime(1_000)

    expect(events).toEqual([true, false])
    expect(context.disconnected).toContain('source')
    expect(context.closed).toBe(true)
  })

  it('reset() clears the speaking flag without tearing the detector down', () => {
    const { detector, analyser, events } = build()
    analyser.wave = LOUD
    vi.advanceTimersByTime(50)

    detector.reset()
    analyser.wave = LOUD
    vi.advanceTimersByTime(50)

    expect(events).toEqual([true, false, true])
  })

  it('returns null instead of throwing when Web Audio is unavailable', () => {
    const events = []

    expect(createVoiceDetector({ id: 'stream' }, (speaking) => events.push(speaking), { audioContextFactory: () => null })).toBeNull()
    expect(
      createVoiceDetector({ id: 'stream' }, (speaking) => events.push(speaking), {
        audioContextFactory: () => {
          throw new Error('no audio hardware')
        },
      }),
    ).toBeNull()
    expect(createVoiceDetector(null, () => {})).toBeNull()
    expect(events).toEqual([])
  })

  it('never connects the analyser to the destination (no echo, no playback)', () => {
    const { context } = build()

    vi.advanceTimersByTime(50)

    expect(context.created).toBe(1)
    expect(context.connected).toHaveLength(1) // analyser only, never destination
    expect(context.connected[0]).not.toBe('destination')
  })
})
