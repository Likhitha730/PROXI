// Unit tests for remote-player interpolation.

import { describe, expect, it } from 'vitest'
import { createMotionBuffer, lerpAngle } from './interpolation.js'
import { LIMITS } from '../../../shared/protocol.js'

describe('lerpAngle', () => {
  /** Wrapped angular difference: 3.31 rad and -2.97 rad are the same angle. */
  const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

  it('takes the short way around the wrap point', () => {
    // 170° -> -170° is +20° through 180°, not -340° the other way
    const from = (170 * Math.PI) / 180
    const to = (-170 * Math.PI) / 180
    const middle = lerpAngle(from, to, 0.5)

    expect(Math.abs(angleDelta(middle, Math.PI))).toBeLessThan(1e-9) // exactly 180°
    expect(angleDelta(lerpAngle(from, to, 1), to)).toBeCloseTo(0, 9)
    expect(angleDelta(lerpAngle(from, to, 0), from)).toBeCloseTo(0, 9)
  })

  it('interpolates ordinary angles without wrapping', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 9)
    expect(lerpAngle(1, 2, 0.25)).toBeCloseTo(1.25, 9)
  })
})

describe('motion buffer', () => {
  const bufferAt = (samples, options = {}) => {
    const buffer = createMotionBuffer(options)
    for (const sample of samples) buffer.push(sample)
    return buffer
  }

  it('renders the interpolated past, not the newest sample', () => {
    const buffer = bufferAt([
      { x: 0, y: 0, dir: 0, moving: true, at: 0 },
      { x: 100, y: 0, dir: 0, moving: true, at: 100 },
    ])
    // delay (120 ms) puts us before the first sample -> hold the oldest
    expect(buffer.sample(100)).toMatchObject({ x: 0, y: 0 })

    // at t=170 the render time is 50 ms: half way between the two samples
    const state = buffer.sample(170)
    expect(state.x).toBeCloseTo(50, 5)
    expect(state.moving).toBe(true)
    expect(state.extrapolated).toBe(false)
  })

  it('interpolates smoothly across a stream of 15 Hz samples', () => {
    const buffer = createMotionBuffer()
    const step = 205 / LIMITS.MOVE_UPDATES_PER_SECOND // u travelled per update
    for (let i = 0; i < 6; i += 1) {
      buffer.push({ x: i * step, y: 0, dir: 0, moving: true, at: i * 66.6 })
    }

    const positions = []
    for (let now = 200; now <= 500; now += 10) positions.push(buffer.sample(now).x)

    // monotonic, and each 10 ms step advances by roughly v*dt (no jumps)
    for (let i = 1; i < positions.length; i += 1) {
      const delta = positions[i] - positions[i - 1]
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThan(4) // 205 u/s * 10 ms = 2.05 u
    }
  })

  it('extrapolates briefly when the stream pauses, then holds', () => {
    const buffer = bufferAt([
      { x: 0, y: 0, dir: 0, moving: true, at: 0 },
      { x: 10, y: 0, dir: 0, moving: true, at: 100 },
    ])

    const justAfter = buffer.sample(100 + LIMITS.INTERPOLATION_DELAY_MS + 20)
    expect(justAfter.extrapolated).toBe(true)
    expect(justAfter.x).toBeGreaterThan(10)
    expect(justAfter.x).toBeLessThan(10 + 0.1 * LIMITS.EXTRAPOLATION_LIMIT_MS + 5)

    // well past the window: clamped, not flung across the map
    const wayLater = buffer.sample(100 + LIMITS.INTERPOLATION_DELAY_MS + LIMITS.EXTRAPOLATION_LIMIT_MS + 500)
    expect(wayLater.extrapolated).toBe(true)
    expect(wayLater.x).toBeCloseTo(10 + 0.1 * LIMITS.EXTRAPOLATION_LIMIT_MS, 5)
    expect(wayLater.stale).toBe(true)
  })

  it('holds position when the peer is standing still', () => {
    const buffer = bufferAt([
      { x: 42, y: 24, dir: 1, moving: false, at: 0 },
      { x: 42, y: 24, dir: 1, moving: false, at: 100 },
    ])
    const state = buffer.sample(1000)
    expect(state).toMatchObject({ x: 42, y: 24, moving: false, extrapolated: false })
  })

  it('ignores out-of-order samples and accepts a same-timestamp correction', () => {
    const buffer = bufferAt([
      { x: 0, y: 0, at: 0 },
      { x: 10, y: 0, at: 100 },
    ])
    expect(buffer.push({ x: 50, y: 50, at: 50 })).toBe(false)
    expect(buffer.size).toBe(2)

    expect(buffer.push({ x: 12, y: 3, at: 100 })).toBe(true)
    expect(buffer.newest).toMatchObject({ x: 12, y: 3 })
    expect(buffer.size).toBe(2)
  })

  it('rejects non-finite samples and caps history', () => {
    const buffer = createMotionBuffer({ maxSamples: 3 })
    expect(buffer.push({ x: Number.NaN, y: 0, at: 0 })).toBe(false)
    expect(buffer.push({ x: 0, y: 0, at: Number.POSITIVE_INFINITY })).toBe(false)
    expect(buffer.size).toBe(0)

    for (let i = 0; i < 10; i += 1) buffer.push({ x: i, y: 0, at: i })
    expect(buffer.size).toBe(3)
  })

  it('returns null before any sample arrives and clears cleanly', () => {
    const buffer = createMotionBuffer()
    expect(buffer.sample(0)).toBeNull()
    buffer.push({ x: 1, y: 1, at: 0 })
    expect(buffer.sample(0)).not.toBeNull()
    buffer.clear()
    expect(buffer.sample(0)).toBeNull()
    expect(buffer.size).toBe(0)
  })

  it('never yields NaN coordinates, even with no usable clock', () => {
    // Regression: a caller that passes no timestamp used to produce NaN, which
    // drew the avatar nowhere at all (caught by the recording canvas context).
    const buffer = bufferAt([
      { x: 100, y: 200, dir: 0, moving: true, at: 1000 },
      { x: 140, y: 200, dir: 0, moving: true, at: 1100 },
    ])

    for (const clock of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = buffer.sample(clock)
      expect(Number.isFinite(state.x), `x with clock ${String(clock)}`).toBe(true)
      expect(Number.isFinite(state.y), `y with clock ${String(clock)}`).toBe(true)
      expect(Number.isFinite(state.dir)).toBe(true)
      expect(Number.isFinite(state.sampleAge)).toBe(true)
    }
  })

  it('reuses one result object (no per-frame garbage)', () => {
    const buffer = bufferAt([
      { x: 0, y: 0, at: 0 },
      { x: 10, y: 0, at: 100 },
    ])
    expect(buffer.sample(150)).toBe(buffer.sample(150))
  })
})
