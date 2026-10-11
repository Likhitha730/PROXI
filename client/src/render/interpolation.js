// Remote-player motion buffer.
//
// Network samples arrive at ~15 Hz while we render at 60 fps, so drawing the
// newest sample directly makes avatars stutter. Instead we render the *past*:
//
//   renderTime = now - INTERPOLATION_DELAY_MS
//
// and interpolate between the two samples that bracket that time. A 120 ms delay
// (a bit under two update periods) guarantees we almost always have a sample on
// each side, which turns jagged steps into smooth motion.
//
// When the stream pauses (packet loss, a lag spike) we extrapolate along the last
// known velocity for at most EXTRAPOLATION_LIMIT_MS, then hold the last position
// rather than flinging the avatar into a wall.
//
// This module is deliberately pure and allocation-light: `sample()` writes into a
// reusable result object, because it runs once per remote player per frame.

import { LIMITS } from '../../../shared/protocol.js'

/** Shortest-arc angle interpolation (angles wrap at ±π). */
export function lerpAngle(from, to, t) {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * t
}

/**
 * @param {{
 *   delayMs?: number,
 *   extrapolationLimitMs?: number,
 *   maxSamples?: number,
 * }} [options]
 */
export function createMotionBuffer(options = {}) {
  const delayMs = options.delayMs ?? LIMITS.INTERPOLATION_DELAY_MS
  const extrapolationLimitMs = options.extrapolationLimitMs ?? LIMITS.EXTRAPOLATION_LIMIT_MS
  const maxSamples = options.maxSamples ?? 12

  /** @type {Array<{x:number,y:number,dir:number,moving:boolean,at:number}>} */
  const samples = []

  const result = { x: 0, y: 0, dir: 0, moving: false, stale: false, extrapolated: false, sampleAge: 0 }

  return {
    get size() {
      return samples.length
    },

    get delayMs() {
      return delayMs
    },

    /** Latest raw sample, without interpolation (used for lag/telemetry). */
    get newest() {
      return samples.length > 0 ? samples[samples.length - 1] : null
    },

    /**
     * Add a network sample. `at` is a local arrival time in milliseconds.
     * Out-of-order and duplicate-timestamp samples are dropped so the buffer
     * always stays monotonic.
     */
    push({ x, y, dir = 0, moving = false, at }) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(at)) return false

      const last = samples[samples.length - 1]
      if (last) {
        if (at < last.at) return false // a late packet must not rewind the avatar
        if (at === last.at) {
          samples[samples.length - 1] = { x, y, dir, moving, at }
          return true
        }
      }

      samples.push({ x, y, dir, moving, at })
      while (samples.length > maxSamples) samples.shift()
      return true
    },

    /**
     * Position at `now` (local clock), interpolated or briefly extrapolated.
     * The returned object is reused — copy it if you need to keep it.
     */
    sample(now) {
      if (samples.length === 0) return null

      const first = samples[0]
      const last = samples[samples.length - 1]
      // Defence in depth: a caller with no clock (or a broken one) must never
      // turn into NaN coordinates — that would draw the avatar nowhere at all.
      const reference = Number.isFinite(now) ? now : last.at
      const renderTime = reference - delayMs

      // Not enough history yet: sit on the oldest known position.
      if (!Number.isFinite(reference) || renderTime <= first.at) {
        result.x = first.x
        result.y = first.y
        result.dir = first.dir
        result.moving = first.moving
        result.stale = false
        result.extrapolated = false
        result.sampleAge = Number.isFinite(now) ? now - first.at : 0
        return result
      }

      // Find the pair bracketing renderTime.
      let before = first
      let after = null
      for (let i = samples.length - 1; i >= 0; i -= 1) {
        if (samples[i].at <= renderTime) {
          before = samples[i]
          after = samples[i + 1] ?? null
          break
        }
      }

      if (after) {
        const span = after.at - before.at
        const t = span > 0 ? (renderTime - before.at) / span : 0
        result.x = before.x + (after.x - before.x) * t
        result.y = before.y + (after.y - before.y) * t
        result.dir = lerpAngle(before.dir, after.dir, t)
        result.moving = t < 1 ? before.moving || after.moving : after.moving
        result.extrapolated = false
      } else {
        // Past the newest sample: coast on its velocity, but only briefly.
        const previous = samples.length >= 2 ? samples[samples.length - 2] : null
        const aheadMs = Math.min(renderTime - last.at, extrapolationLimitMs)
        if (previous && last.moving) {
          const dt = last.at - previous.at
          const vx = dt > 0 ? (last.x - previous.x) / dt : 0
          const vy = dt > 0 ? (last.y - previous.y) / dt : 0
          result.x = last.x + vx * aheadMs
          result.y = last.y + vy * aheadMs
          result.extrapolated = true
        } else {
          result.x = last.x
          result.y = last.y
          result.extrapolated = false
        }
        result.dir = last.dir
        result.moving = last.moving
      }

      result.sampleAge = Number.isFinite(now) ? now - last.at : 0
      // "stale" means the stream has gone quiet for longer than we are willing to
      // extrapolate — the caller may want to show the peer as lagging.
      result.stale = result.sampleAge > delayMs + extrapolationLimitMs
      return result
    },

    clear() {
      samples.length = 0
    },
  }
}
