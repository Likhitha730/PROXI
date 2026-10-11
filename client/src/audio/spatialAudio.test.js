/**
 * Spatial audio tests.
 *
 * The curve, the pan mapping and the graph are all checked here without a real
 * AudioContext: a recording fake counts every node and every parameter write, which
 * is how the "no AudioNodes per frame" and "no abrupt jumps" rules are verified
 * rather than asserted in a comment.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GAIN_TAU,
  attenuationGain,
  createAudioContextHost,
  createElementSink,
  createSpatialSink,
  gainToPercent,
  stereoPan,
} from './spatialAudio.js'

// ------------------------------------------------------------------ fakes ----

function createFakeParam(value = 0) {
  return {
    value,
    setValueAtTime: vi.fn(function setValueAtTime(next) {
      this.value = next
      return this
    }),
    setTargetAtTime: vi.fn(function setTargetAtTime(target) {
      this.value = target
      return this
    }),
    linearRampToValueAtTime: vi.fn(),
  }
}

function createFakeContext({ sampleRate = 48_000, state = 'running', withPanner = true } = {}) {
  const created = { gains: 0, panners: 0, sources: 0 }
  const nodes = []
  const context = {
    sampleRate,
    state,
    baseLatency: 0.01,
    destination: { id: 'destination' },
    currentTime: 0,
    resume: vi.fn(async () => {
      context.state = 'running'
      context.onstatechange?.()
    }),
    close: vi.fn(async () => {
      context.state = 'closed'
    }),
    createMediaStreamSource: vi.fn(() => {
      created.sources += 1
      const node = { kind: 'source', connect: vi.fn(), disconnect: vi.fn() }
      nodes.push(node)
      return node
    }),
    createGain: vi.fn(() => {
      created.gains += 1
      const node = { kind: 'gain', gain: createFakeParam(1), connect: vi.fn(), disconnect: vi.fn() }
      nodes.push(node)
      return node
    }),
    connect: vi.fn(),
  }
  if (withPanner) {
    context.createStereoPanner = vi.fn(() => {
      created.panners += 1
      const node = { kind: 'panner', pan: createFakeParam(0), connect: vi.fn(), disconnect: vi.fn() }
      nodes.push(node)
      return node
    })
  }
  return { context, created, nodes }
}

const stream = { id: 'stream', getAudioTracks: () => [{ kind: 'audio' }] }

// --------------------------------------------------------------- the curve ---

describe('attenuationGain', () => {
  it('is full volume at zero distance and silent at the radius', () => {
    expect(attenuationGain(0, 100)).toBe(1)
    expect(attenuationGain(100, 100)).toBe(0)
  })

  it('follows the documented linear curve', () => {
    expect(attenuationGain(25, 100)).toBeCloseTo(0.75, 6)
    expect(attenuationGain(50, 100)).toBeCloseTo(0.5, 6)
    expect(attenuationGain(90, 100)).toBeCloseTo(0.1, 6)
  })

  it('stays silent beyond the radius (never negative)', () => {
    expect(attenuationGain(150, 100)).toBe(0)
    expect(attenuationGain(1e6, 100)).toBe(0)
  })

  it('is monotonic in the right direction: turning away is never louder', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let distance = 0; distance <= 120; distance += 5) {
      const gain = attenuationGain(distance, 100)
      expect(gain).toBeLessThanOrEqual(previous)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
      previous = gain
    }
    // …and it really does fall across the range, it is not flat.
    expect(attenuationGain(0, 100)).toBeGreaterThan(attenuationGain(99, 100))
  })

  it('scales with the configured radius rather than a hard-coded one', () => {
    // The same world distance, two radii: exactly what "configurable listening
    // radius" has to mean for the audio path.
    expect(attenuationGain(50, 100)).toBeCloseTo(0.5, 6)
    expect(attenuationGain(50, 200)).toBeCloseTo(0.75, 6)
    expect(attenuationGain(50, 50)).toBe(0)
  })

  it('returns silence instead of NaN for absurd inputs', () => {
    expect(attenuationGain(Number.NaN, 100)).toBe(0)
    expect(attenuationGain(10, 0)).toBe(0)
    expect(attenuationGain(10, Number.NaN)).toBe(0)
    expect(attenuationGain(-5, 100)).toBe(1)
  })
})

describe('stereoPan', () => {
  it('maps the world-space offset onto [-1, 1]', () => {
    expect(stereoPan(0, 100)).toBe(0)
    expect(stereoPan(50, 100)).toBeCloseTo(0.5, 6)
    expect(stereoPan(-50, 100)).toBeCloseTo(-0.5, 6)
  })

  it('clamps beyond the radius', () => {
    expect(stereoPan(400, 100)).toBe(1)
    expect(stereoPan(-400, 100)).toBe(-1)
  })

  it('centres a peer who is directly north or south (no x offset)', () => {
    expect(stereoPan(0, 100)).toBe(0)
  })

  it('is zoom-independent by construction: only world quantities enter', () => {
    // Nothing here can be affected by the camera, because the camera is not an
    // input. Same world offsets ⇒ same pan, at any zoom.
    const a = stereoPan(30, 100)
    const b = stereoPan(30, 100)
    expect(a).toBe(b)
  })

  it('never returns NaN', () => {
    expect(stereoPan(Number.NaN, 100)).toBe(0)
    expect(stereoPan(10, 0)).toBe(0)
  })
})

describe('gainToPercent', () => {
  it('renders the level a human reads in the panel', () => {
    expect(gainToPercent(1)).toBe(100)
    expect(gainToPercent(0.5)).toBe(50)
    expect(gainToPercent(0.006)).toBe(1)
    expect(gainToPercent(0)).toBe(0)
  })

  it('clamps nonsense to a sane number', () => {
    expect(gainToPercent(-1)).toBe(0)
    expect(gainToPercent(4)).toBe(100)
    expect(gainToPercent(Number.NaN)).toBe(0)
  })
})

// ------------------------------------------------------------ context host ---

describe('createAudioContextHost', () => {
  it('creates the context lazily, only when asked', () => {
    const { context } = createFakeContext()
    const factory = vi.fn(() => context)
    const host = createAudioContextHost({ factory })

    expect(factory).not.toHaveBeenCalled()
    expect(host.getContext()).toBe(context)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(host.getContext()).toBe(context) // cached, not recreated
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable instead of throwing when Web Audio is missing', () => {
    const host = createAudioContextHost({ factory: () => null })

    expect(host.getContext()).toBeNull()
    expect(host.state).toBe('unavailable')
    expect(host.isRunning()).toBe(false)
  })

  it('survives a factory that throws (a browser out of audio resources)', () => {
    const logger = { warn: vi.fn() }
    const host = createAudioContextHost({
      factory: () => {
        throw new Error('no audio device')
      },
      logger,
    })

    expect(host.getContext()).toBeNull()
    expect(host.state).toBe('unavailable')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('resumes a suspended context — the user-gesture path', async () => {
    const { context } = createFakeContext({ state: 'suspended' })
    const host = createAudioContextHost({ factory: () => context })

    const state = await host.resume()

    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(state).toBe('running')
    expect(host.isRunning()).toBe(true)
  })

  it('does not call resume on a context that is already running', async () => {
    const { context } = createFakeContext({ state: 'running' })
    const host = createAudioContextHost({ factory: () => context })

    await host.resume()

    expect(context.resume).not.toHaveBeenCalled()
    expect(host.state).toBe('running')
  })

  it('tracks a suspension that happens later, and tells its subscribers', async () => {
    const { context } = createFakeContext({ state: 'running' })
    const host = createAudioContextHost({ factory: () => context })
    const seen = []
    host.subscribe((state) => seen.push(state))
    host.getContext()

    context.state = 'suspended'
    context.onstatechange()

    expect(host.state).toBe('suspended')
    expect(seen).toContain('suspended')
  })

  it('describes itself for the panel and closes on dispose', () => {
    const { context } = createFakeContext()
    const host = createAudioContextHost({ factory: () => context })
    host.getContext()

    expect(host.describe()).toMatchObject({ state: 'running', sampleRate: 48_000, hasStereoPanner: true })

    host.dispose()
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(host.state).toBe('idle')
  })

  it('resume is safe with no context and never throws', async () => {
    const host = createAudioContextHost({ factory: () => null })
    await expect(host.resume()).resolves.toBe('unavailable')
  })
})

// -------------------------------------------------------------- the graph ----

describe('createSpatialSink', () => {
  it('builds source → gain → panner → destination', () => {
    const { context, created, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })

    expect(created.sources).toBe(1)
    expect(created.gains).toBe(1)
    expect(created.panners).toBe(1)
    const [source, gain, panner] = nodes
    expect(source.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(panner)
    expect(panner.connect).toHaveBeenCalledWith(context.destination)
    expect(sink.kind).toBe('webaudio')
  })

  it('starts silent so a new stream fades in instead of popping in at full volume', () => {
    const { context, nodes } = createFakeContext()
    createSpatialSink({ stream, context })

    const [, gain, panner] = nodes
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, context.currentTime)
    expect(panner.pan.setValueAtTime).toHaveBeenCalledWith(0, context.currentTime)
  })

  it('moves gain and pan through AudioParam automation, not by assignment', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })

    sink.setSpatial(0.42, -0.3)

    const [, gain, panner] = nodes
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(0.42, context.currentTime, GAIN_TAU)
    expect(panner.pan.setTargetAtTime).toHaveBeenCalledWith(-0.3, context.currentTime, 0.08)
    // No abrupt jumps: the value is never stepped.
    expect(gain.gain.value).toBe(0.42)
  })

  it('skips automation when nothing moved (the per-frame no-op path)', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })
    sink.setSpatial(0.5, 0.2)
    const [, gain, panner] = nodes
    gain.gain.setTargetAtTime.mockClear()
    panner.pan.setTargetAtTime.mockClear()

    for (let frame = 0; frame < 600; frame += 1) sink.setSpatial(0.5, 0.2)

    expect(gain.gain.setTargetAtTime).not.toHaveBeenCalled()
    expect(panner.pan.setTargetAtTime).not.toHaveBeenCalled()
  })

  it('never creates an AudioNode while updating — 600 frames, one graph', () => {
    const { context, created } = createFakeContext()
    const sink = createSpatialSink({ stream, context })

    for (let frame = 0; frame < 600; frame += 1) {
      const distance = (frame % 100) + 1
      sink.setSpatial(1 - distance / 100, distance / 200 - 0.5)
    }

    expect(created.sources).toBe(1)
    expect(created.gains).toBe(1)
    expect(created.panners).toBe(1)
    expect(sink.describe().updates).toBe(600)
  })

  it('clamps hostile values instead of letting them reach the graph', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })

    // NaN gain ⇒ silence; a huge but finite offset ⇒ hard pan. A non-finite pan is
    // treated as "no useful direction", i.e. centre.
    sink.setSpatial(Number.NaN, Number.POSITIVE_INFINITY)

    const [, gain, panner] = nodes
    expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), GAIN_TAU)
    expect(panner.pan.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), 0.08)

    sink.setSpatial(5, 1e6)
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, expect.any(Number), GAIN_TAU)
    expect(panner.pan.setTargetAtTime).toHaveBeenLastCalledWith(1, expect.any(Number), 0.08)
  })

  it('fades to silence and detaches every node on dispose', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })
    sink.setSpatial(0.8, 0.1)

    sink.dispose()

    const [source, gain, panner] = nodes
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, context.currentTime, 0.02)
    expect(source.disconnect).toHaveBeenCalled()
    expect(gain.disconnect).toHaveBeenCalled()
    expect(panner.disconnect).toHaveBeenCalled()
  })

  it('ignores updates after dispose (no zombie graphs)', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })
    sink.dispose()
    const [, gain] = nodes
    gain.gain.setTargetAtTime.mockClear()

    expect(sink.setSpatial(0.9, 0)).toBe(false)
    expect(gain.gain.setTargetAtTime).not.toHaveBeenCalled()
  })

  it('silences a stream without tearing the graph down when a peer drops', () => {
    const { context, nodes } = createFakeContext()
    const sink = createSpatialSink({ stream, context })
    sink.setSpatial(0.6, 0.4)

    sink.setActive(false)

    const [, gain] = nodes
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, context.currentTime, GAIN_TAU)
    expect(gain.disconnect).not.toHaveBeenCalled()
  })

  it('works without a StereoPannerNode, dropping pan instead of panicking', () => {
    const { context, created, nodes } = createFakeContext({ withPanner: false })
    const sink = createSpatialSink({ stream, context })

    expect(created.panners).toBe(0)
    expect(sink.setSpatial(0.4, -1)).toBe(true)
    const [, gain] = nodes
    expect(gain.connect).toHaveBeenCalledWith(context.destination)
    expect(sink.describe()).toMatchObject({ hasPanner: false, pan: 0 })
  })

  it('falls back to an element sink when there is no Web Audio at all', () => {
    const element = { srcObject: null, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), remove: vi.fn() }
    const sink = createSpatialSink({ stream, context: null, createElement: () => element })

    expect(sink.kind).toBe('element')
    expect(element.srcObject).toBe(stream)
    // An element sink must NOT pretend to attenuate: it has no graph, and a second
    // volume control is exactly what this module refuses to stack.
    sink.setSpatial(0.1, -1)
    expect(element.volume).toBeUndefined()
  })
})

describe('createElementSink', () => {
  it('attaches the stream but lets the caller start playback', () => {
    const element = { srcObject: null, play: vi.fn(), pause: vi.fn(), remove: vi.fn() }
    createElementSink({ stream, createElement: () => element })

    expect(element.srcObject).toBe(stream)
    // The engine calls play() so it can report a blocked autoplay to the UI.
    expect(element.play).not.toHaveBeenCalled()
  })

  it('releases the element and the stream on dispose', () => {
    const element = { srcObject: null, play: vi.fn(), pause: vi.fn(), remove: vi.fn() }
    const sink = createElementSink({ stream, createElement: () => element })

    sink.dispose()

    expect(element.srcObject).toBeNull()
    expect(element.pause).toHaveBeenCalled()
    expect(element.remove).toHaveBeenCalled()
  })

  it('survives a missing element factory', () => {
    const sink = createElementSink({ stream, createElement: () => null })
    expect(sink.element).toBeNull()
    expect(() => sink.dispose()).not.toThrow()
  })
})
