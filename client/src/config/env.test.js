import { describe, expect, it } from 'vitest'
import { apiUrl, env } from './env.js'

describe('client env config', () => {
  it('exposes documented defaults with no .env file present', () => {
    expect(env.appName).toBe('ProxiSpeak')
    // Empty means "same origin": the Vite dev proxy (and Express in production)
    // forwards /api and /socket.io to the backend.
    expect(env.socketUrl).toBe('')
    expect(env.apiUrl).toBe('')
    expect(typeof env.mode).toBe('string')
  })

  it('builds same-origin API paths that the dev proxy can forward', () => {
    expect(apiUrl('/api/health')).toBe('/api/health')
    expect(apiUrl('api/health')).toBe('/api/health')
  })
})
