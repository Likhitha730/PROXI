// Test doubles for Canvas 2D.
//
// There is no browser in CI or in the sandbox, so rendering is exercised against
// a recording fake context: every drawing call is counted and any typo in a drawer
// (calling an undefined method, passing NaN geometry) throws instead of silently
// doing nothing.

const GRADIENT = { addColorStop() {} }

export function createFakeContext(canvas = { width: 1280, height: 720 }) {
  const calls = new Map()
  const record = (name, args) => {
    calls.set(name, (calls.get(name) ?? 0) + 1)
    for (const arg of args) {
      if (typeof arg === 'number' && !Number.isFinite(arg)) {
        throw new Error(`Non-finite argument passed to ctx.${name}: ${args.join(', ')}`)
      }
    }
  }

  const state = {
    canvas,
    calls,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'source-over',
  }

  const methods = {
    measureText: (text) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => GRADIENT,
    createRadialGradient: () => GRADIENT,
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: () => {},
    drawImage: (...args) => record('drawImage', args.filter((a) => typeof a === 'number')),
    getLineDash: () => [],
  }

  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop in methods) return methods[prop]
      // Any other canvas method becomes a recording no-op.
      return (...args) => record(String(prop), args.filter((arg) => typeof arg === 'number'))
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  })
}

/** Minimal canvas element accepted by the engine in tests. */
export function createFakeCanvas(cssWidth = 960, cssHeight = 540, context = createFakeContext()) {
  const listeners = new Map()
  return {
    width: 0,
    height: 0,
    style: {},
    classList: { add() {}, remove() {} },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight, right: cssWidth, bottom: cssHeight }),
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      listeners.set(
        type,
        list.filter((entry) => entry !== handler),
      )
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    listenerCount() {
      let total = 0
      for (const list of listeners.values()) total += list.length
      return total
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
  }
}

/**
 * Deterministic requestAnimationFrame replacement.
 * Frames advance only when the test says so, which makes movement, throttling and
 * teardown assertions exact.
 */
export function installFakeRaf() {
  const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  const stats = { scheduled: 0, cancelled: 0, ran: 0 }
  let pending = null
  let pendingId = 0
  let now = 0

  globalThis.requestAnimationFrame = (callback) => {
    pending = callback
    pendingId += 1
    stats.scheduled += 1
    return pendingId
  }
  globalThis.cancelAnimationFrame = () => {
    stats.cancelled += 1
    pending = null
  }

  return {
    stats,
    get hasPendingFrame() {
      return pending !== null
    },
    get now() {
      return now
    },
    /** Run `count` frames, each advancing the clock by `deltaMs`. */
    step(count = 1, deltaMs = 16) {
      for (let i = 0; i < count; i += 1) {
        if (!pending) return i
        const callback = pending
        pending = null
        now += deltaMs
        callback(now)
        stats.ran += 1
      }
      return count
    },
    restore() {
      globalThis.requestAnimationFrame = original.requestAnimationFrame
      globalThis.cancelAnimationFrame = original.cancelAnimationFrame
    },
  }
}

/** Dispatch a keyboard event (the engine listens on window). */
export function pressKey(code, { type = 'keydown', target = globalThis.document } = {}) {
  const event = new globalThis.window.KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/**
 * Press and release a key.
 * The engine deliberately ignores auto-repeat (a held key fires its action once),
 * so discrete actions in tests must be tapped, not just pressed.
 */
export function tapKey(code, options = {}) {
  pressKey(code, { ...options, type: 'keydown' })
  return pressKey(code, { ...options, type: 'keyup' })
}
