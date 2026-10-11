/**
 * Keyboard input tests — this is the "users can still type in inputs" guarantee.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createKeyboardInput, isTypingTarget } from './keyboard.js'
import { pressKey, tapKey } from '../test/fakeCanvas.js'

let input

afterEach(() => {
  input?.detach?.()
  input = null
  for (const element of globalThis.document.querySelectorAll('input, textarea, [contenteditable]')) element.remove()
  globalThis.document.body.focus?.()
})

function createInput(handler = () => {}) {
  input = createKeyboardInput({ onAction: handler })
  input.attach()
  return input
}

/** Release a key (the engine tracks held keys by code). */
function release(keyboard, code) {
  pressKey(code, { type: 'keyup' })
  return keyboard
}

function focusElement(tag, { editable = 'attribute', ...attributes } = {}) {
  const element = globalThis.document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  if (tag === 'div') {
    // Markup style (`contenteditable="true"`) or script style (`el.contentEditable`):
    // jsdom supports one without the other, so the guard must handle both.
    if (editable === 'attribute') element.setAttribute('contenteditable', 'true')
    else element.contentEditable = 'true'
  }
  globalThis.document.body.appendChild(element)
  element.focus()
  return element
}

describe('isTypingTarget', () => {
  it('recognises text fields and contenteditable elements', () => {
    const text = globalThis.document.createElement('input')
    const area = globalThis.document.createElement('textarea')
    const select = globalThis.document.createElement('select')
    const editable = globalThis.document.createElement('div')
    editable.contentEditable = 'true'
    const plain = globalThis.document.createElement('div')

    for (const element of [text, area, select, editable]) {
      expect(isTypingTarget(element), element.tagName).toBe(true)
    }
    expect(isTypingTarget(plain)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('movement axis', () => {
  it('reads WASD', () => {
    const keyboard = createInput()
    pressKey('KeyD')
    expect(keyboard.movementAxis()).toEqual({ x: 1, y: 0 })
    release(keyboard, 'KeyD')

    pressKey('KeyW')
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: -1 })
    release(keyboard, 'KeyW')

    pressKey('KeyS')
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 1 })
    release(keyboard, 'KeyS')

    pressKey('KeyA')
    expect(keyboard.movementAxis()).toEqual({ x: -1, y: 0 })
    release(keyboard, 'KeyA')

    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('reads the arrow keys', () => {
    const keyboard = createInput()
    pressKey('ArrowRight')
    expect(keyboard.movementAxis()).toEqual({ x: 1, y: 0 })
    pressKey('ArrowUp')
    expect(keyboard.movementAxis()).toEqual({ x: 1, y: -1 })
    release(keyboard, 'ArrowRight')
    release(keyboard, 'ArrowUp')
    pressKey('ArrowDown')
    pressKey('ArrowLeft')
    expect(keyboard.movementAxis()).toEqual({ x: -1, y: 1 })
  })

  it('never exceeds ±1 per axis when opposite keys are held', () => {
    const keyboard = createInput()
    pressKey('KeyA')
    pressKey('KeyD')
    pressKey('KeyW')
    pressKey('KeyS')
    const axis = keyboard.movementAxis()
    expect(Math.abs(axis.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(axis.y)).toBeLessThanOrEqual(1)
  })

  it('stops moving when keys are released', () => {
    const keyboard = createInput()
    pressKey('KeyD')
    pressKey('KeyD', { type: 'keyup' })
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })
})

describe('typing safety', () => {
  it('ignores movement keys while an input is focused', () => {
    const keyboard = createInput()
    const field = focusElement('input')
    pressKey('KeyD', { target: field })
    pressKey('KeyW', { target: field })
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('ignores movement keys while a contenteditable is focused (attribute form)', () => {
    const keyboard = createInput()
    const editable = focusElement('div', { editable: 'attribute' })
    pressKey('KeyD', { target: editable })
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('ignores movement keys while a contenteditable is focused (property form)', () => {
    const keyboard = createInput()
    const editable = focusElement('div', { editable: 'property' })
    pressKey('KeyD', { target: editable })
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('does not swallow the key event while typing', () => {
    createInput()
    const field = focusElement('input')
    const event = pressKey('ArrowLeft', { target: field })
    expect(event.defaultPrevented).toBe(false)
  })

  it('resumes movement after the field loses focus', () => {
    const keyboard = createInput()
    const field = focusElement('input')
    pressKey('KeyD', { target: field })
    expect(keyboard.movementAxis().x).toBe(0)

    field.blur()
    keybardFocusBody()
    pressKey('KeyD')
    expect(keyboard.movementAxis().x).toBe(1)
  })

  function keybardFocusBody() {
    globalThis.document.body.focus?.()
  }
})

describe('shortcut keys', () => {
  it('fires camera and view actions once per press', () => {
    const actions = []
    createInput((action) => actions.push(action))

    tapKey('Equal')
    tapKey('Minus')
    tapKey('Digit0')
    tapKey('KeyR')
    tapKey('KeyF')
    tapKey('KeyL')
    tapKey('Digit2')

    expect(actions).toEqual([
      'zoom-in',
      'zoom-out',
      'reset-zoom',
      'reset-camera',
      'toggle-follow',
      'toggle-labels',
      'spawn-2',
    ])
  })

  it('ignores auto-repeat so a held key fires its action once', () => {
    const actions = []
    createInput((action) => actions.push(action))
    pressKey('KeyL')
    pressKey('KeyL')
    pressKey('KeyL')
    expect(actions).toEqual(['toggle-labels'])
  })

  it('ignores actions while typing', () => {
    const actions = []
    createInput((action) => actions.push(action))
    const field = focusElement('input')
    tapKey('KeyL', { target: field })
    tapKey('KeyR', { target: field })
    expect(actions).toEqual([])
  })

  it('ignores browser shortcuts (ctrl/meta/alt)', () => {
    const actions = []
    createInput((action) => actions.push(action))
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const event = new globalThis.window.KeyboardEvent('keydown', { code: 'KeyL', key: 'l', [modifier]: true, bubbles: true })
      globalThis.document.dispatchEvent(event)
    }
    expect(actions).toEqual([])
  })

  it('prevents the browser default for movement keys (page scrolling)', () => {
    createInput()
    const event = pressKey('ArrowDown')
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('lifecycle', () => {
  it('detaches cleanly and forgets held keys', () => {
    const keyboard = createInput()
    pressKey('KeyD')
    expect(keyboard.movementAxis().x).toBe(1)

    keyboard.detach()
    expect(keyboard.attached).toBe(false)
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })

    // events after detach are ignored
    pressKey('KeyD')
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('clears held keys when the window loses focus', () => {
    const keyboard = createInput()
    pressKey('KeyD')
    globalThis.window.dispatchEvent(new globalThis.window.Event('blur'))
    expect(keyboard.movementAxis()).toEqual({ x: 0, y: 0 })
  })

  it('is safe to attach and detach twice', () => {
    const keyboard = createInput()
    expect(() => {
      keyboard.attach()
      keyboard.detach()
      keyboard.detach()
    }).not.toThrow()
  })
})
