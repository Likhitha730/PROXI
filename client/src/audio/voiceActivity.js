// Voice activity detection — is this stream carrying speech right now?
//
// Deliberately the simplest thing that works: an AnalyserNode reads the waveform,
// the detector computes an RMS level, and a threshold with a short hangover turns
// that into a boolean for the "speaking" indicator.
//
// What this is NOT: there is no speech recognition, no recording, no buffering of
// samples, and nothing is ever sent anywhere. The only value that leaves this module
// is a boolean. It is not used for gain or routing either — distance-based volume and
// panning are explicitly out of scope for this session.
//
// It is used for both the local microphone (so your own avatar lights up) and remote
// streams (so the person you are talking to lights up on your screen).

import { LIMITS } from '../../../shared/protocol.js'

const FFT_SIZE = 512
const POLL_INTERVAL_MS = 100

function defaultAudioContextFactory() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
  return Ctor ? new Ctor() : null
}

/**
 * @param {MediaStream} stream
 * @param {(speaking: boolean) => void} onSpeaking
 * @param {{
 *   audioContextFactory?: () => AudioContext|null,
 *   threshold?: number,
 *   hangMs?: number,
 *   intervalMs?: number,
 * }} [options]
 * @returns {{ stop: () => void, reset: () => void, level: () => number } | null}
 *   null when Web Audio is unavailable — callers treat the indicator as simply off.
 */
export function createVoiceDetector(
  stream,
  onSpeaking,
  {
    audioContextFactory = defaultAudioContextFactory,
    threshold = LIMITS.SPEAKING_RMS_THRESHOLD,
    hangMs = LIMITS.SPEAKING_HANG_MS,
    intervalMs = POLL_INTERVAL_MS,
  } = {},
) {
  if (!stream || typeof onSpeaking !== 'function') return null

  let context
  let source
  let analyser
  let buffer
  let timer = null
  let speaking = false
  let lastLoudAt = 0
  let level = 0

  try {
    context = audioContextFactory()
    if (!context?.createAnalyser || !context.createMediaStreamSource) return null
    source = context.createMediaStreamSource(stream)
    analyser = context.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0.2
    buffer = new Float32Array(analyser.fftSize)
    source.connect(analyser)
    // Intentionally NOT connected to the destination: analysing a stream must never
    // play it back (the local microphone would otherwise echo).
  } catch {
    return null
  }

  function sample() {
    if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(buffer)
    else {
      // Older implementations only expose the byte API.
      const bytes = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(bytes)
      for (let index = 0; index < bytes.length; index += 1) buffer[index] = (bytes[index] - 128) / 128
    }

    let sum = 0
    for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index]
    level = Math.sqrt(sum / buffer.length)

    const at = Date.now()
    if (level >= threshold) lastLoudAt = at

    const next = at - lastLoudAt <= hangMs
    if (next !== speaking) {
      speaking = next
      onSpeaking(next)
    }
  }

  timer = setInterval(sample, intervalMs)
  // Node/jsdom timers must not hold the process open (the browser ignores this).
  timer?.unref?.()

  return {
    /** Current RMS level — exposed for tests and diagnostics, never logged as content. */
    level: () => level,
    reset() {
      lastLoudAt = 0
      if (speaking) {
        speaking = false
        onSpeaking(false)
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      try {
        source?.disconnect?.()
        analyser?.disconnect?.()
      } catch {
        /* already detached */
      }
      // Close only contexts we created; shared contexts are the caller's business.
      try {
        context?.close?.()
      } catch {
        /* already closed */
      }
      if (speaking) {
        speaking = false
        onSpeaking(false)
      }
    },
  }
}
