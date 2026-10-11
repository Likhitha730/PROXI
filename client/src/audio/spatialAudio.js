// Spatial audio — the Web Audio graph that makes proximity *audible*.
//
// One managed graph per remote stream:
//
//   MediaStreamAudioSourceNode → GainNode → [StereoPannerNode] → destination
//
// Rules this module exists to enforce:
//
//   * **World units only.** Attenuation is computed from world-space distance. No
//     screen coordinate, no camera zoom and no pixel ever enters this file, so
//     zooming the camera cannot change how loud somebody sounds.
//   * **One volume control per stream.** The graph owns a single GainNode and a
//     single panner for a stream; nothing else may write to them. Changing the
//     curve means changing this one function.
//   * **No abrupt jumps.** Targets are applied through AudioParam automation
//     (`setTargetAtTime`), which approaches the new value smoothly instead of
//     stepping to it. New streams fade in from silence rather than starting at
//     whatever the node's default gain happened to be.
//   * **No nodes per frame.** Parameters are updated in place every frame; nodes
//     are created when a stream arrives and torn down when it ends.
//
// The documented starting curve is linear (docs/ARCHITECTURE.md §9):
//
//   gain = clamp(1 - distance / listeningRadius, 0, 1)
//
// At distance 0 that is 1 (full volume), at the listening radius it is 0 (silent),
// and beyond the radius it stays 0. Panning is equally simple:
//
//   pan = clamp(relativeX / listeningRadius, -1, 1)
//
// where `relativeX` is the peer's world x minus the listener's world x: someone
// standing to your east sits to the right, someone north or south of you is centred.
// Both are pure functions, so they are unit-tested directly.

/** How fast an AudioParam approaches its new target (seconds). Smaller = snappier. */
export const GAIN_TAU = 0.06
export const PAN_TAU = 0.08

/** Below this difference the parameter is left alone (avoids pointless scheduling). */
export const GAIN_EPSILON = 0.002
export const PAN_EPSILON = 0.005

/**
 * The documented attenuation curve.
 *
 * @param {number} distance world-space distance in world units (never pixels)
 * @param {number} radius the listening radius in the same world units
 * @returns {number} gain in [0, 1]
 */
export function attenuationGain(distance, radius) {
  if (!Number.isFinite(distance) || !Number.isFinite(radius) || radius <= 0) return 0
  if (distance <= 0) return 1
  if (distance >= radius) return 0
  return 1 - distance / radius
}

/**
 * Stereo position for a peer, in [-1, 1] (−1 hard left, 0 centre, 1 hard right).
 * Zoom-independent: it is a ratio of two world-space quantities.
 */
export function stereoPan(relativeX, radius) {
  if (!Number.isFinite(relativeX) || !Number.isFinite(radius) || radius <= 0) return 0
  const pan = relativeX / radius
  return pan < -1 ? -1 : pan > 1 ? 1 : pan
}

/** Convenience for the UI: "heard at 35%". */
export function gainToPercent(gain) {
  if (!Number.isFinite(gain)) return 0
  return Math.round(Math.max(0, Math.min(1, gain)) * 100)
}

/**
 * The one AudioContext the app uses.
 *
 * Browsers create contexts suspended until a user gesture, so `resume()` must be
 * called from one — the engine calls it from the microphone button. If Web Audio is
 * missing entirely (`jsdom`, an exotic browser), `state` stays `unavailable` and the
 * engine falls back to plain `<audio>` playback with no attenuation.
 */
export function createAudioContextHost({ factory, logger = null } = {}) {
  const create = factory ?? defaultContextFactory
  let context = null
  let state = 'idle' // idle | running | suspended | unavailable | closed
  let listeners = null

  function notify() {
    for (const listener of listeners ?? []) listener(state)
  }

  function setState(next) {
    if (state === next) return state
    state = next
    notify()
    return state
  }

  function getContext() {
    if (context) return context
    try {
      context = create?.() ?? null
    } catch (error) {
      // A browser that refuses to create a context is not an error worth throwing
      // into an event handler: we simply have no attenuation.
      logger?.warn?.('could not create an AudioContext', { name: error?.name })
      context = null
    }
    if (!context) {
      setState('unavailable')
      return null
    }
    setState(context.state === 'running' ? 'running' : 'suspended')
    // A context can be suspended by the browser later (tab backgrounded, device
    // change); keep our view of it in step.
    context.onstatechange = () => setState(context?.state ?? 'closed')
    return context
  }

  return {
    getContext,
    get state() {
      return state
    },
    /**
     * Resume from a user gesture. Safe to call repeatedly, safe when there is no
     * context at all, and it never throws: a refusal just leaves the state visible.
     */
    async resume() {
      const current = getContext()
      if (!current) return state
      if (current.state === 'running') return setState('running')
      try {
        await current.resume()
      } catch (error) {
        logger?.warn?.('AudioContext could not resume', { name: error?.name })
      }
      return setState(current.state === 'running' ? 'running' : 'suspended')
    },
    /** True once a context exists and is running — the UI's "audio ready" signal. */
    isRunning() {
      return state === 'running'
    },
    describe() {
      return {
        state,
        sampleRate: context?.sampleRate ?? null,
        latency: context?.baseLatency ?? null,
        hasStereoPanner: Boolean(context?.createStereoPanner),
      }
    },
    subscribe(listener) {
      if (!listeners) listeners = new Set()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Release the context (only ever the one we created). */
    dispose() {
      listeners?.clear()
      listeners = null
      try {
        context?.close?.()
      } catch {
        /* already closed */
      }
      context = null
      setState('idle')
    },
  }
}

function defaultContextFactory() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
  return Ctor ? new Ctor() : null
}

/**
 * Build the spatial graph for one remote stream.
 *
 * @param {object} params
 * @param {MediaStream} params.stream
 * @param {AudioContext} params.context
 * @param {boolean} [params.supportsStereoPanner] defaults to probing the context
 * @param {(stream: MediaStream) => HTMLAudioElement|null} [params.createElement] fallback sink
 * @returns {{ kind: 'webaudio'|'element', setSpatial: Function, setActive: Function, dispose: Function, describe: Function }}
 */
export function createSpatialSink({ stream, context, supportsStereoPanner, createElement, gainTau = GAIN_TAU, panTau = PAN_TAU } = {}) {
  const canUseWebAudio = Boolean(context && context.createMediaStreamSource && context.createGain && stream)

  if (!canUseWebAudio) {
    // Fallback: plain element playback, owned by the element sink below.
    return createElementSink({ stream, createElement })
  }

  const source = context.createMediaStreamSource(stream)
  const gainNode = context.createGain()
  const hasPanner = supportsStereoPanner ?? Boolean(context.createStereoPanner)
  const panner = hasPanner ? context.createStereoPanner() : null

  // Start silent and fade in: a stream must never begin at an arbitrary gain and
  // then jump to its computed value.
  gainNode.gain.setValueAtTime(0, context.currentTime)
  source.connect(gainNode)
  if (panner) {
    panner.pan.setValueAtTime(0, context.currentTime)
    gainNode.connect(panner)
    panner.connect(context.destination)
  } else {
    gainNode.connect(context.destination)
  }

  let targetGain = 0
  let targetPan = 0
  let appliedGain = -1
  let appliedPan = -1
  let disposed = false
  let frames = 0

  function setSpatial(nextGain, nextPan) {
    if (disposed) return false
    const wanted = Number.isFinite(nextGain) ? Math.max(0, Math.min(1, nextGain)) : 0
    const wantedPan = hasPanner ? (Number.isFinite(nextPan) ? Math.max(-1, Math.min(1, nextPan)) : 0) : 0
    targetGain = wanted
    targetPan = wantedPan
    frames += 1

    // Only touch the parameters when something actually moved. This is what keeps
    // the per-frame cost at "a couple of comparisons" instead of a stream of
    // automation events, and it is why nothing is audible when nobody moves.
    if (Math.abs(wanted - appliedGain) > GAIN_EPSILON) {
      gainNode.gain.setTargetAtTime(wanted, context.currentTime, gainTau)
      appliedGain = wanted
    }
    if (hasPanner && Math.abs(wantedPan - appliedPan) > PAN_EPSILON) {
      panner.pan.setTargetAtTime(wantedPan, context.currentTime, panTau)
      appliedPan = wantedPan
    }
    return true
  }

  /** Silence without tearing the graph down (peer disconnected, stream ended). */
  function setActive(active) {
    if (disposed) return
    if (!active) setSpatial(0, targetPan)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    // Fade to silence, then detach. The short ramp is what prevents the click that
    // a hard disconnect would otherwise produce.
    try {
      gainNode.gain.setTargetAtTime(0, context.currentTime, 0.02)
    } catch {
      /* context already gone */
    }
    try {
      source.disconnect()
      gainNode.disconnect()
      panner?.disconnect()
    } catch {
      /* already detached */
    }
  }

  return {
    kind: 'webaudio',
    element: null,
    setSpatial,
    setActive,
    dispose,
    describe: () => ({ kind: 'webaudio', gain: targetGain, pan: targetPan, hasPanner, updates: frames }),
  }
}

/**
 * The `<audio>`-element sink, kept for browsers without Web Audio.
 *
 * It deliberately has **no** gain control of its own: with no graph there is nothing
 * to attenuate, and silently playing at full volume is better than pretending to
 * attenuate while stacking a second control on the same stream.
 */
export function createElementSink({ stream, createElement } = {}) {
  const element = createElement?.() ?? null
  if (element && stream) {
    // The engine calls play() — it is the layer that can report a blocked autoplay
    // to the UI, and calling it here too would start playback twice.
    element.srcObject = stream
  }
  return {
    kind: 'element',
    element,
    setSpatial() {},
    setActive() {},
    dispose() {
      if (!element) return
      try {
        element.srcObject = null
        element.pause?.()
      } catch {
        /* detached */
      }
      element.remove?.()
    },
    describe: () => ({ kind: 'element', gain: 1, pan: 0, hasPanner: false }),
  }
}
