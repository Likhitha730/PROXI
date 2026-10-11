// Keyboard input for the world engine.
//
// Two rules matter here:
//   1. Typing always wins — while a text field (or any editable element) has
//      focus, the game ignores every key, so users can still type.
//   2. Nothing leaks — listeners are attached and removed by the caller, and the
//      key set is cleared on window blur so a held key can't stick when the user
//      switches tabs mid-walk.

const MOVEMENT_KEYS = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
}

/** Keys whose browser default (scrolling) must be suppressed while playing. */
const PREVENT_DEFAULT = new Set(Object.keys(MOVEMENT_KEYS))

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * True when the event is aimed at something the user is typing into.
 *
 * Three signals are checked because no single one is reliable everywhere:
 *   * `isContentEditable` is the computed value (best signal, but jsdom and some
 *     embedded webviews do not implement it),
 *   * the `contentEditable` property is set by scripts,
 *   * the `contenteditable` attribute is what markup produces.
 * Missing an editable element would mean hijacking somebody's typing, so this
 * fails safe by trusting whichever signal is available.
 */
export function isTypingTarget(target) {
  if (!target) return false
  if (EDITABLE_TAGS.has(target.tagName)) return true
  if (target.isContentEditable === true) return true

  const editableProperty = target.contentEditable
  if (editableProperty === 'true' || editableProperty === 'plaintext-only') return true

  if (typeof target.getAttribute === 'function') {
    const editableAttribute = target.getAttribute('contenteditable')
    if (editableAttribute !== null && editableAttribute !== 'false') return true
  }
  return false
}

/**
 * @param {{ target?: EventTarget, onAction?: (action: string, event: KeyboardEvent) => void }} [options]
 */
export function createKeyboardInput(options = {}) {
  const target = options.target ?? globalThis.window
  const onAction = options.onAction ?? (() => {})
  const pressed = new Set()
  let attached = false

  const isTyping = (event) => isTypingTarget(event.target) || isTypingTarget(globalThis.document?.activeElement)
  const isShortcutModifier = (event) => event.metaKey || event.ctrlKey || event.altKey

  function handleKeyDown(event) {
    if (isTyping(event) || isShortcutModifier(event)) return
    const repeated = pressed.has(event.code)
    pressed.add(event.code)

    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault()
    if (repeated) return // only fire one action per physical key press

    switch (event.code) {
      case 'Equal':
      case 'NumpadAdd':
        onAction('zoom-in', event)
        break
      case 'Minus':
      case 'NumpadSubtract':
        onAction('zoom-out', event)
        break
      case 'Digit0':
      case 'Numpad0':
        onAction('reset-zoom', event)
        break
      case 'KeyR':
        onAction('reset-camera', event)
        break
      case 'KeyF':
        onAction('toggle-follow', event)
        break
      case 'KeyL':
        onAction('toggle-labels', event)
        break
      case 'Digit1':
        onAction('spawn-1', event)
        break
      case 'Digit2':
        onAction('spawn-2', event)
        break
      case 'Digit3':
        onAction('spawn-3', event)
        break
      default:
        break
    }
  }

  function handleKeyUp(event) {
    pressed.delete(event.code)
  }

  function clear() {
    pressed.clear()
  }

  function attach() {
    if (attached) return
    attached = true
    target.addEventListener('keydown', handleKeyDown)
    target.addEventListener('keyup', handleKeyUp)
    target.addEventListener('blur', clear)
  }

  function detach() {
    if (!attached) return
    attached = false
    target.removeEventListener('keydown', handleKeyDown)
    target.removeEventListener('keyup', handleKeyUp)
    target.removeEventListener('blur', clear)
    clear()
  }

  /** Normalised movement axis: x = right, y = down (screen/world space). */
  function movementAxis() {
    let x = 0
    let y = 0
    // A held key is registered per code; map codes → axis.
    for (const code of pressed) {
      const direction = MOVEMENT_KEYS[code]
      if (!direction) continue
      if (direction === 'up') y -= 1
      else if (direction === 'down') y += 1
      else if (direction === 'left') x -= 1
      else if (direction === 'right') x += 1
    }
    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }
  }

  return {
    attach,
    detach,
    clear,
    movementAxis,
    isPressed: (code) => pressed.has(code),
    get pressedKeys() {
      return [...pressed]
    },
    get attached() {
      return attached
    },
  }
}
