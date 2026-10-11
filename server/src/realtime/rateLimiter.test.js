// Unit tests for the movement rate limiter.

import { describe, expect, it } from 'vitest'
import { createTokenBucket } from './rateLimiter.js'

describe('token bucket', () => {
  it('allows a burst up to the bucket size, then throttles', () => {
    const bucket = createTokenBucket({ ratePerSecond: 15, burst: 5, now: () => 0 })

    for (let i = 0; i < 5; i += 1) expect(bucket.take(0)).toBe(true)
    expect(bucket.take(0)).toBe(false)
    expect(bucket.accepted).toBe(5)
    expect(bucket.dropped).toBe(1)
  })

  it('refills at the configured sustained rate', () => {
    const bucket = createTokenBucket({ ratePerSecond: 15, burst: 5, now: () => 0 })
    for (let i = 0; i < 5; i += 1) bucket.take(0)

    // 15/s => one token every ~66.7 ms
    expect(bucket.take(50)).toBe(false)
    expect(bucket.take(67)).toBe(true)
    expect(bucket.take(67)).toBe(false)

    // a full second restores the whole burst, but never more
    for (let i = 0; i < 5; i += 1) expect(bucket.take(1067)).toBe(true)
    expect(bucket.take(1067)).toBe(false)
  })

  it('sustains 15 updates per second indefinitely', () => {
    const bucket = createTokenBucket({ ratePerSecond: 15, burst: 5, now: () => 0 })
    let accepted = 0
    for (let tick = 0; tick < 3000; tick += 1) {
      if (bucket.take(tick * (1000 / 15))) accepted += 1
    }
    expect(accepted).toBe(3000)
  })

  it('counts drops without throwing and never goes negative on time travel', () => {
    const bucket = createTokenBucket({ ratePerSecond: 15, burst: 2, now: () => 1000 })
    expect(bucket.take(1000)).toBe(true)
    expect(bucket.take(999)).toBe(true) // clock jitter must not refill
    expect(bucket.available).toBe(0)
    expect(bucket.take(999)).toBe(false)
  })
})
