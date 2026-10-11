// Token-bucket rate limiter for the realtime hot path.
//
// A player may move continuously, so the budget is "sustained rate + a small
// burst": the bucket refills at `ratePerSecond` and starts full with `burst`
// tokens, which absorbs jitter in a well-behaved client's timer while still
// capping a hostile one at a few updates per second.
//
// `take(now)` accepts an explicit timestamp so tests are deterministic.

export function createTokenBucket({ ratePerSecond, burst, now = Date.now }) {
  const capacity = Math.max(1, burst)
  const refillPerMs = ratePerSecond / 1000

  let tokens = capacity
  let updatedAt = now()
  let accepted = 0
  let dropped = 0

  return {
    take(at = now()) {
      const elapsed = Math.max(0, at - updatedAt)
      updatedAt = at
      tokens = Math.min(capacity, tokens + elapsed * refillPerMs)

      if (tokens < 1) {
        dropped += 1
        return false
      }
      tokens -= 1
      accepted += 1
      return true
    },

    get accepted() {
      return accepted
    },

    get dropped() {
      return dropped
    },

    /** Tokens currently available (fractional). */
    get available() {
      return tokens
    },
  }
}
