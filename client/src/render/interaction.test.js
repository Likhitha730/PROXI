/**
 * Interaction + motion helper tests.
 *
 * Picking and easing are pure functions, so the rules ("which avatar did I click",
 * "how does a speaking ring fade") are checked directly instead of by eyeballing the
 * canvas.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMotionPreference, pickAvatar, smoothTowards } from './interaction.js'

const ADA = { id: 'ada', x: 100, y: 100 }
const GRACE = { id: 'grace', x: 130, y: 100 }
const FAR = { id: 'far', x: 900, y: 900 }

describe('pickAvatar', () => {
  it('returns the avatar under the point', () => {
    expect(pickAvatar({ x: 100, y: 100 }, [ADA, GRACE])?.id).toBe('ada')
    expect(pickAvatar({ x: 132, y: 101 }, [ADA, GRACE])?.id).toBe('grace')
  })

  it('returns the nearest when two avatars overlap the hit radius', () => {
    const near = { id: 'near', x: 118, y: 100 }
    expect(pickAvatar({ x: 116, y: 100 }, [ADA, near, GRACE])?.id).toBe('near')
  })

  it('returns null when nothing is close enough', () => {
    expect(pickAvatar({ x: 400, y: 400 }, [ADA, GRACE, FAR])).toBeNull()
    expect(pickAvatar({ x: 0, y: 0 }, [])).toBeNull()
  })

  it('honours the world-space hit radius (the engine scales it by zoom for the pointer)', () => {
    expect(pickAvatar({ x: 100, y: 140 }, [ADA], { worldRadius: 20 })).toBeNull()
    expect(pickAvatar({ x: 100, y: 140 }, [ADA], { worldRadius: 45 })?.id).toBe('ada')
  })

  it('can exclude one avatar (the caller already knows who it is looking at)', () => {
    expect(pickAvatar({ x: 100, y: 100 }, [ADA, GRACE], { exclude: 'ada' })).toBeNull()
  })

  it('ignores malformed input instead of throwing', () => {
    expect(pickAvatar(null, [ADA])).toBeNull()
    expect(pickAvatar({ x: Number.NaN, y: 0 }, [ADA])).toBeNull()
    expect(pickAvatar({ x: 100, y: 100 }, [null, undefined, { id: 'ghost' }])).toBeNull()
    expect(pickAvatar({ x: 100, y: 100 }, [ADA], { worldRadius: 0 })).toBeNull()
  })
})

describe('smoothTowards', () => {
  it('rises fast and decays slowly, so a speaking ring does not strobe', () => {
    const attack = smoothTowards(0, 1, 1 / 60, { attack: 14, release: 5 })
    const release = smoothTowards(1, 0, 1 / 60, { attack: 14, release: 5 })

    expect(attack).toBeGreaterThan(0.15)
    // One frame of release moves the value less than one frame of attack does.
    expect(1 - release).toBeLessThan(attack)
  })

  it('approaches the target without overshooting', () => {
    let value = 0
    for (let frame = 0; frame < 200; frame += 1) {
      value = smoothTowards(value, 1, 1 / 60)
      expect(value).toBeLessThanOrEqual(1)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(value).toBeCloseTo(1, 3)
  })

  it('snaps to the target once it is close, so the value settles exactly', () => {
    let value = 0
    for (let frame = 0; frame < 400; frame += 1) value = smoothTowards(value, 1, 1 / 60)
    expect(value).toBe(1)
  })

  it('is frame-rate independent: two half-steps land where one full step does', () => {
    const oneStep = smoothTowards(0, 1, 1 / 30, { attack: 14, release: 5 })
    const twoSteps = smoothTowards(smoothTowards(0, 1, 1 / 60, { attack: 14, release: 5 }), 1, 1 / 60, { attack: 14, release: 5 })

    expect(twoSteps).toBeCloseTo(oneStep, 3)
  })

  it('clamps a huge delta time so a backgrounded tab cannot teleport the value', () => {
    expect(smoothTowards(0, 1, 30)).toBeLessThan(1)
    expect(smoothTowards(0, 1, 30)).toBeCloseTo(smoothTowards(0, 1, 0.1), 6)
  })

  it('never returns NaN', () => {
    expect(smoothTowards(Number.NaN, 1, 1 / 60)).toBeGreaterThanOrEqual(0)
    expect(smoothTowards(0, Number.NaN, 1 / 60)).toBe(0)
    expect(smoothTowards(0, 1, Number.NaN)).toBe(0)
  })
})

describe('createMotionPreference', () => {
  function fakeMedia({ matches = false } = {}) {
    const listeners = []
    return {
      listeners,
      matchMedia: vi.fn(() => ({
        matches,
        addEventListener: (event, handler) => listeners.push(handler),
        removeEventListener: (event, handler) => {
          const index = listeners.indexOf(handler)
          if (index >= 0) listeners.splice(index, 1)
        },
      })),
    }
  }

  it('reports the system preference at construction', () => {
    expect(createMotionPreference(fakeMedia({ matches: false })).reduced).toBe(false)
    expect(createMotionPreference(fakeMedia({ matches: true })).reduced).toBe(true)
  })

  it('follows a change while the app is running', () => {
    const media = fakeMedia({ matches: false })
    const preference = createMotionPreference(media)
    const seen = []
    preference.subscribe((reduced) => seen.push(reduced))

    media.listeners.forEach((handler) => handler({ matches: true }))

    expect(preference.reduced).toBe(true)
    expect(seen).toEqual([true])
  })

  it('cleans up its listener on dispose', () => {
    const media = fakeMedia()
    const preference = createMotionPreference(media)
    preference.subscribe(() => {})

    preference.dispose()

    expect(media.listeners).toHaveLength(0)
  })

  it('degrades to "full motion" where matchMedia does not exist (or throws)', () => {
    expect(createMotionPreference({ matchMedia: undefined }).reduced).toBe(false)
    expect(createMotionPreference({ matchMedia: undefined }).supported).toBe(false)
    expect(
      createMotionPreference({
        matchMedia: () => {
          throw new Error('no media queries')
        },
      }).reduced,
    ).toBe(false)
  })
})
