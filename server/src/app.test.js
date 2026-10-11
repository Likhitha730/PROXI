// Integration tests: real Express app, real HTTP server, real Socket.IO client.
// Nothing here is mocked — these are the checks that prove the milestone works.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { io as ioClient } from 'socket.io-client'
import { createServer } from './index.js'
import { parseConfig } from './config/env.js'
import { createLogger } from './lib/logger.js'

const FRONTEND_ORIGIN = 'http://localhost:5173'

let httpServer
let baseUrl
let config
let logs

/** Captures emitted log records (children included) so we can assert on safe logging. */
function createRecordingLogger(records = []) {
  const inner = createLogger({ level: 'debug', scope: 'test', sink: { write() {} } })
  const wrap = (level) => (message, meta) => {
    records.push({ level, message, meta })
    inner[level](message, meta)
  }
  return {
    records,
    logger: {
      level: 'debug',
      scope: 'test',
      error: wrap('error'),
      warn: wrap('warn'),
      info: wrap('info'),
      debug: wrap('debug'),
      child: () => createRecordingLogger(records).logger,
    },
  }
}

beforeAll(async () => {
  config = parseConfig({ NODE_ENV: 'test', CORS_ORIGIN: FRONTEND_ORIGIN, MONGODB_URI: '' })
  const recording = createRecordingLogger()
  logs = recording.records

  const created = createServer({ config, logger: recording.logger })
  httpServer = created.httpServer

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address()
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

function connectClient(options = {}) {
  return ioClient(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
    ...options,
  })
}

const waitFor = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), 5000)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })

describe('GET /api/health', () => {
  it('returns 200 with status ok and no environment values', async () => {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { origin: FRONTEND_ORIGIN } })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.service).toBe('proxispeak-server')
    expect(typeof body.version).toBe('string')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    // Persistence is disabled without MONGODB_URI — and that is a valid state.
    expect(body.database.status).toBe('disabled')

    const serialised = JSON.stringify(body)
    expect(serialised).not.toMatch(/mongodb(\+srv)?:\/\//i)
    expect(serialised).not.toMatch(/MONGODB_URI|CORS_ORIGIN|LOG_LEVEL|SHUTDOWN_TIMEOUT_MS/)
    expect(serialised).not.toMatch(/"port"|"host"/)
  })

  it('answers the API index with the endpoint list', async () => {
    const response = await fetch(`${baseUrl}/api`)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.endpoints).toContain('/api/health')
  })

  it('returns JSON 404 for unknown API routes', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`)
    const body = await response.json()
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})

describe('CORS policy', () => {
  it('echoes the allowed origin only for registered origins', async () => {
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { origin: FRONTEND_ORIGIN } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe(FRONTEND_ORIGIN)
    expect(allowed.headers.get('vary')).toContain('Origin')

    const denied = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://evil.test' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(denied.status).toBe(200) // CORS is enforced by the browser, not by a crash
  })

  it('rejects a preflight from an unlisted origin', async () => {
    const allowed = await fetch(`${baseUrl}/api/health`, { method: 'OPTIONS', headers: { origin: FRONTEND_ORIGIN } })
    expect(allowed.status).toBe(204)

    const denied = await fetch(`${baseUrl}/api/health`, { method: 'OPTIONS', headers: { origin: 'http://evil.test' } })
    expect(denied.status).toBe(403)
  })
})

describe('Socket.IO', () => {
  it('accepts a browser-shaped client from the allowed origin', async () => {
    const client = connectClient({ extraHeaders: { origin: FRONTEND_ORIGIN } })
    await waitFor(client, 'connect')
    expect(client.connected).toBe(true)
    expect(typeof client.id).toBe('string')
    client.close()
  })

  it('accepts polling as the fallback transport', async () => {
    const client = connectClient({ transports: ['polling'], extraHeaders: { origin: FRONTEND_ORIGIN } })
    await waitFor(client, 'connect')
    expect(client.connected).toBe(true)
    client.close()
  })

  it('refuses a handshake from an origin outside the allow-list', async () => {
    // HTTP-level proof: engine.io answers 400 and sends no CORS headers, so a
    // browser cannot read the response and the client never connects.
    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'http://evil.test' },
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()

    // Same origin gets a working handshake for contrast.
    const allowed = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: FRONTEND_ORIGIN },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(FRONTEND_ORIGIN)

    // Client-level proof: the socket surfaces an error and stays disconnected.
    const client = connectClient({ extraHeaders: { origin: 'http://evil.test' } })
    await waitFor(client, 'connect_error')
    expect(client.connected).toBe(false)
    expect(client.id).toBeUndefined()
    client.close()
  })

  it('ignores unknown client events without throwing', async () => {
    const client = connectClient({ extraHeaders: { origin: FRONTEND_ORIGIN } })
    await waitFor(client, 'connect')
    client.emit('totally:unknown', { anything: true })
    client.emit('session:join', { name: 'not-implemented-yet' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(client.connected).toBe(true)
    client.close()
  })

  it('serves no legacy client script (serveClient: false)', async () => {
    const response = await fetch(`${baseUrl}/socket.io/socket.io.js`)
    // engine.io answers a JSON protocol error instead of shipping the bundle.
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(await response.text()).not.toMatch(/socket\.io\.js|engine\.io/i)
  })
})

describe('safe connection logging', () => {
  it('logs connect and disconnect with ids but no secrets or headers', async () => {
    const client = connectClient({ extraHeaders: { origin: FRONTEND_ORIGIN, cookie: 'session=super-secret' } })
    await waitFor(client, 'connect')
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const connected = logs.find((record) => record.message === 'socket connected')
    expect(connected).toBeTruthy()
    expect(connected.meta.socketId).toBeTruthy()
    expect(connected.meta.origin).toBe(FRONTEND_ORIGIN)

    const disconnected = logs.find((record) => record.message === 'socket disconnected')
    expect(disconnected).toBeTruthy()
    expect(disconnected.meta.reason).toBe('client namespace disconnect')

    const serialised = JSON.stringify(logs)
    expect(serialised).not.toMatch(/super-secret/)
    expect(serialised).not.toMatch(/MONGODB_URI|mongodb\+srv/)
  })
})
