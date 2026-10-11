/**
 * Disconnected-state test: no backend at all.
 *
 * The shell must never look broken: it has to render, show the loading state,
 * then explain that the backend is unreachable and offer a retry — without
 * throwing. The socket points at a port where nothing is listening.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost:5173/" }
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'

// Closed port: connections are refused immediately.
const DEAD_BACKEND = 'http://127.0.0.1:8095'
import.meta.env.VITE_SOCKET_URL = DEAD_BACKEND
import.meta.env.VITE_API_URL = DEAD_BACKEND

const { default: App } = await import('./App.jsx')
const { destroySocket } = await import('./net/socketClient.js')

let container
let root

async function waitForDom(predicate, { timeoutMs = 15_000, label = 'DOM condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = {
      text: container?.textContent ?? '',
      query: (selector) => container?.querySelector(selector) ?? null,
      queryText: (selector) => container?.querySelector(selector)?.textContent ?? '',
    }
    if (predicate(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out waiting for ${label}. DOM was:\n${snapshot?.text}`)
}

beforeAll(() => {
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(<App />)
})

afterAll(() => {
  root?.unmount()
  container?.remove()
  destroySocket()
})

describe('ProxiSpeak shell with the backend unreachable', () => {
  it('still renders the application shell (never a blank page)', async () => {
    const snapshot = await waitForDom(({ text }) => text.includes('World stage'), {
      label: 'shell render without a backend',
    })
    expect(snapshot.text).toContain('ProxiSpeak')
    // The header badge reports the connection problem instead of pretending to be live.
    expect(snapshot.query('.badge')).not.toBeNull()
  })

  it('shows the backend-offline state with guidance, not a crash', async () => {
    const snapshot = await waitForDom(({ text }) => text.includes('Backend unreachable'), {
      label: 'offline overlay',
    })
    expect(snapshot.query('.overlay--error')).not.toBeNull()
    expect(snapshot.text).toContain('npm run dev:server')
    expect(snapshot.query('.button')).not.toBeNull()
    // The health chip must not claim the backend is online.
    expect(snapshot.query('.chip')?.textContent).toContain('Backend offline')
  })

  it('lets the user retry and returns to a connecting state without throwing', async () => {
    const button = await waitForDom(({ query }) => query('.button') !== null, { label: 'retry button' })
    expect(() => button.query('.button').click()).not.toThrow()
    const after = await waitForDom(({ query }) => query('.overlay') !== null, { label: 'overlay after retry' })
    expect(after.query('.overlay')).not.toBeNull()
    expect(after.text).not.toContain('World stage\n\nTypeError')
  })
})
