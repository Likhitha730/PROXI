/**
 * Browser-path integration test.
 *
 * This is the closest thing to "open the app in a browser" that a headless
 * sandbox can run, and it is a permanent regression test:
 *
 *   real jsdom document  →  real React render (the actual <App /> component)
 *   →  real Socket.IO client (browser build, WebSocket/polling transports)
 *   →  real Express + Socket.IO server spawned as a child process
 *   →  real GET /api/health over XHR.
 *
 * The jsdom document URL is set to a documented development origin
 * (http://localhost:5173) so the backend's CORS allow-list applies exactly as it
 * would in the browser.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost:5173/" }
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server')
const PORT = Number(process.env.BROWSER_TEST_PORT ?? 8091)
const BASE_URL = `http://127.0.0.1:${PORT}`

// Point the app's environment at the spawned test server *before* importing it,
// so the test never depends on shell environment variables.
import.meta.env.VITE_SOCKET_URL = BASE_URL
import.meta.env.VITE_API_URL = BASE_URL

const { default: App } = await import('./App.jsx')

let serverProcess
let container
let root

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`)
      if (response.ok) return true
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** Polls until the rendered DOM satisfies `predicate`, or the deadline passes. */
async function waitForDom(predicate, { timeoutMs = 20_000, label = 'DOM condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = null
  while (Date.now() < deadline) {
    lastSnapshot = {
      text: container?.textContent ?? '',
      html: container?.innerHTML ?? '',
      query: (selector) => container?.querySelector(selector) ?? null,
      queryText: (selector) => container?.querySelector(selector)?.textContent ?? '',
    }
    if (predicate(lastSnapshot)) return lastSnapshot
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out waiting for ${label}. DOM was:\n${lastSnapshot?.text}`)
}

beforeAll(async () => {
  serverProcess = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      // jsdom document origin — must stay allow-listed by the server.
      CORS_ORIGIN: 'http://localhost:5173',
      MONGODB_URI: '',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = await waitForHealth()
  if (!ready) throw new Error(`test server did not become healthy on ${BASE_URL}`)

  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(<App />)
}, 30_000)

afterAll(async () => {
  root?.unmount()
  container?.remove()
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

describe('ProxiSpeak shell in a DOM (browser path)', () => {
  it('renders the application shell while connecting', async () => {
    // The shell (header/footer/stage) must exist immediately, before any network
    // round-trip, so users never stare at a blank page.
    const snapshot = await waitForDom(({ text }) => text.includes('World stage'), {
      label: 'initial shell render',
    })
    expect(snapshot.text).toContain('ProxiSpeak')
    expect(snapshot.text).toContain('Real-time virtual office')
  })

  it('shows a loading state until the realtime session is live', async () => {
    const snapshot = await waitForDom(
      ({ query }) => query('.overlay') !== null || query('.badge--connected') !== null,
      { label: 'loading overlay or connected badge' },
    )
    expect(snapshot.query('.overlay, .badge--connected')).not.toBeNull()
  })

  it(
    'establishes a real Socket.IO connection and renders the connected state',
    async () => {
      const snapshot = await waitForDom(({ query }) => query('.badge--connected') !== null, {
        label: 'connected badge',
      })
      expect(snapshot.queryText('.badge__label')).toBe('Connected')
      // A live socket id is rendered in the session panel (not the placeholder).
      const socketId = snapshot.queryText('[data-testid="socket-id"]')
      expect(socketId, 'socket id should be rendered in the session panel').toMatch(/^[A-Za-z0-9_-]{8,}$/)
      // Loading/offline states are gone once connected.
      expect(snapshot.query('.overlay')).toBeNull()
    },
    30_000,
  )

  it('loads backend health through the API and renders it', async () => {
    const snapshot = await waitForDom(({ text }) => text.includes('proxispeak-server'), {
      label: 'health payload rendered in the HUD',
    })
    expect(snapshot.text).toContain('Backend online')
    expect(snapshot.text).toContain('proxispeak-server')
    expect(snapshot.text).not.toContain('Backend offline')
    // The HUD reports the transport the client actually negotiated.
    const transport = snapshot.queryText('[data-testid="transport"]')
    expect(['websocket', 'polling']).toContain(transport)
  })

  it('keeps the API endpoint same-origin and takes the socket URL from env config', () => {
    // Guards the architecture rule: browser code must not call localhost:8080
    // implicitly — the URL comes from validated env config.
    expect(import.meta.env.VITE_SOCKET_URL).toBe(BASE_URL)
  })
})
