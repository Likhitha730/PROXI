/**
 * ICE server resolution tests.
 *
 * The rules under test are the ones that decide whether two browsers can find each
 * other at all: prefer what the server hands out (so TURN credentials never ship in
 * the bundle), fall back to the VITE_* override for development, fall back to a
 * public STUN server, and never throw — a failed lookup must not break the call
 * path, it must just negotiate with less.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ICE_SERVERS, resetIceCache, resolveIceServers } from './iceConfig.js'

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  resetIceCache()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  resetIceCache()
})

describe('resolveIceServers', () => {
  it('uses the servers the backend configured', async () => {
    const servers = [
      { urls: ['stun:stun.example.org:3478'] },
      { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' },
    ]
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: servers, hasTurn: true }))

    const result = await resolveIceServers({ fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/ice')
    expect(result.iceServers).toEqual(servers)
    expect(result.hasTurn).toBe(true)
    expect(result.source).toBe('server')
  })

  it('reports hasTurn false when the server offers no relay', async () => {
    const fetchImpl = async () => jsonResponse({ iceServers: [{ urls: ['stun:stun.example.org:3478'] }] })

    const result = await resolveIceServers({ fetchImpl })

    expect(result.iceServers).toEqual([{ urls: ['stun:stun.example.org:3478'] }])
    expect(result.hasTurn).toBe(false)
  })

  it('caches the answer so a second call does not hit the network again', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: [{ urls: ['stun:a:3478'] }] }))

    const first = await resolveIceServers({ fetchImpl })
    const second = await resolveIceServers({ fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('de-duplicates concurrent lookups (two peers connecting at once)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: [{ urls: ['stun:a:3478'] }] }))

    const [a, b] = await Promise.all([resolveIceServers({ fetchImpl }), resolveIceServers({ fetchImpl })])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('refreshes after the TTL, and immediately when forced', async () => {
    let answer = [{ urls: ['stun:a:3478'] }]
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: answer }))
    let clock = 1_000

    await resolveIceServers({ fetchImpl, now: () => clock })
    answer = [{ urls: ['stun:b:3478'] }]
    clock += 299_000
    expect((await resolveIceServers({ fetchImpl, now: () => clock })).iceServers).toEqual([{ urls: ['stun:a:3478'] }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 2_000
    expect((await resolveIceServers({ fetchImpl, now: () => clock })).iceServers).toEqual([{ urls: ['stun:b:3478'] }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await resolveIceServers({ fetchImpl, now: () => clock, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('falls back to the built-in public STUN server when the backend is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    const result = await resolveIceServers({ fetchImpl })

    expect(result.iceServers).toEqual(DEFAULT_ICE_SERVERS)
    expect(result.source).toBe('default-stun')
    expect(result.hasTurn).toBe(false)
  })

  it('falls back when the route answers with an error status', async () => {
    const result = await resolveIceServers({ fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }) })

    expect(result.source).toBe('default-stun')
    expect(result.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })

  it('falls back when the JSON body is not usable', async () => {
    const result = await resolveIceServers({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      }),
    })

    expect(result.source).toBe('default-stun')
  })

  it('ignores malformed entries and keeps the usable ones', async () => {
    const fetchImpl = async () =>
      jsonResponse({
        iceServers: [
          { urls: 'stun:good:3478' },
          { urls: '' },
          { urls: [] },
          null,
          'stun:not-an-object',
          { urls: ['stun:also-good:3478', 'http://not-ice'] },
          { urls: ['nonsense:3478'] },
        ],
      })

    const result = await resolveIceServers({ fetchImpl })

    expect(result.iceServers).toEqual([
      { urls: ['stun:good:3478'] },
      { urls: ['stun:also-good:3478'] },
    ])
  })

  it('carries TURN credentials through only when both are strings', async () => {
    const result = await resolveIceServers({
      fetchImpl: async () =>
        jsonResponse({
          iceServers: [
            { urls: ['turn:t:3478'], username: 'user', credential: 'secret' },
            { urls: ['turns:t2:5349'], username: 42, credential: null },
          ],
        }),
    })

    expect(result.iceServers).toEqual([
      { urls: ['turn:t:3478'], username: 'user', credential: 'secret' },
      { urls: ['turns:t2:5349'] },
    ])
  })

  it('treats an empty server list as no answer and falls back', async () => {
    const result = await resolveIceServers({ fetchImpl: async () => jsonResponse({ iceServers: [] }) })

    expect(result.source).toBe('default-stun')
  })

  it('falls back when the response is not an object at all', async () => {
    expect((await resolveIceServers({ fetchImpl: null })).source).toBe('default-stun')
    expect((await resolveIceServers({ fetchImpl: async () => null })).source).toBe('default-stun')
    expect((await resolveIceServers({ fetchImpl: async () => jsonResponse(null) })).source).toBe('default-stun')
    expect((await resolveIceServers({ fetchImpl: async () => jsonResponse(42) })).source).toBe('default-stun')
  })

  it('lets a VITE_* override win over the server answer (development only)', async () => {
    // `env` is read at module load, so the stub must be in place before importing.
    vi.resetModules()
    vi.stubEnv('VITE_ICE_STUN_URLS', 'stun:dev-one:3478, stun:dev-two:3478')
    vi.stubEnv('VITE_ICE_TURN_URL', 'turn:dev-turn:3478')
    vi.stubEnv('VITE_ICE_TURN_USERNAME', 'dev-user')
    vi.stubEnv('VITE_ICE_TURN_CREDENTIAL', 'dev-credential')
    const mod = await import('./iceConfig.js?override')
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: [{ urls: ['stun:server:3478'] }], hasTurn: false }))

    const result = await mod.resolveIceServers({ fetchImpl })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.source).toBe('client-env')
    expect(result.iceServers).toEqual([
      { urls: ['stun:dev-one:3478', 'stun:dev-two:3478'] },
      { urls: ['turn:dev-turn:3478'], username: 'dev-user', credential: 'dev-credential' },
    ])
    expect(result.hasTurn).toBe(true)
  })

  it('accepts a TURN url without credentials, and never consults the server', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_ICE_TURN_URL', 'turns:dev-turn:5349')
    const mod = await import('./iceConfig.js?turn-only')
    const fetchImpl = vi.fn()

    const result = await mod.resolveIceServers({ fetchImpl })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.source).toBe('client-env')
    expect(result.iceServers).toEqual([{ urls: ['turns:dev-turn:5349'] }])
    expect(result.hasTurn).toBe(true)
  })

  it('ignores an override that is only whitespace and uses the server instead', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_ICE_STUN_URLS', '   ')
    const mod = await import('./iceConfig.js?blank')
    const fetchImpl = vi.fn(async () => jsonResponse({ iceServers: [{ urls: ['stun:server:3478'] }] }))

    const result = await mod.resolveIceServers({ fetchImpl })

    expect(result.source).toBe('server')
    expect(result.iceServers).toEqual([{ urls: ['stun:server:3478'] }])
  })

  it('caches the fallback too, so a dead backend is not hammered', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })

    await resolveIceServers({ fetchImpl })
    const second = await resolveIceServers({ fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.source).toBe('default-stun')
  })

  it('keeps a sanitised, frozen default so callers cannot mutate the shared list', () => {
    expect(() => {
      DEFAULT_ICE_SERVERS.push({ urls: ['stun:injected:3478'] })
    }).toThrow()
  })
})
