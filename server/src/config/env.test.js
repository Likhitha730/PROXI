import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  createOriginValidator,
  isOriginAllowed,
  parseConfig,
  parseOriginList,
} from './env.js'

describe('parseOriginList', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseOriginList(' http://a.test , http://b.test ,, ')).toEqual(['http://a.test', 'http://b.test'])
  })

  it('falls back to the documented development defaults when unset or blank', () => {
    expect(parseOriginList(undefined)).toEqual(DEFAULTS.CORS_ORIGIN.split(','))
    expect(parseOriginList('   ')).toEqual(DEFAULTS.CORS_ORIGIN.split(','))
  })

  it('keeps an explicit wildcard (opt-in)', () => {
    expect(parseOriginList('*')).toEqual(['*'])
  })
})

describe('parseConfig', () => {
  it('applies every documented default with an empty environment', () => {
    const config = parseConfig({})
    expect(config.port).toBe(8080)
    expect(config.host).toBe('0.0.0.0')
    expect(config.nodeEnv).toBe('development')
    expect(config.isProduction).toBe(false)
    expect(config.logLevel).toBe('info')
    expect(config.mongoUri).toBeNull()
    expect(config.mongoDb).toBe('proxispeak')
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
  })

  it('reads real values and coerces numbers', () => {
    const config = parseConfig({
      PORT: '9090',
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.example.com',
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/',
      SHUTDOWN_TIMEOUT_MS: '2500',
    })
    expect(config.port).toBe(9090)
    expect(config.isProduction).toBe(true)
    expect(config.corsOrigins).toEqual(['https://app.example.com'])
    expect(config.shutdownTimeoutMs).toBe(2500)
    expect(config.mongoUri).toBe('mongodb+srv://user:pass@cluster.example.net/')
  })

  it('fails loudly on an invalid port instead of silently switching', () => {
    expect(() => parseConfig({ PORT: 'not-a-port' })).toThrow(/PORT/)
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => parseConfig({ PORT: '5173.5' })).toThrow(/PORT/)
  })

  it('fails loudly on an unknown log level', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })

  it('returns a frozen object', () => {
    const config = parseConfig({})
    expect(Object.isFrozen(config)).toBe(true)
    expect(() => {
      config.port = 1
    }).toThrow()
  })
})

describe('origin policy', () => {
  it('allows same-origin or non-browser callers without an Origin header', () => {
    expect(isOriginAllowed(undefined, ['http://localhost:5173'])).toBe(true)
  })

  it('allows only listed origins', () => {
    const allowed = ['http://localhost:5173', 'http://127.0.0.1:5173']
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true)
    expect(isOriginAllowed('http://evil.test', allowed)).toBe(false)
    expect(isOriginAllowed('http://localhost:5173.evil.test', allowed)).toBe(false)
  })

  it('honours the explicit wildcard', () => {
    expect(isOriginAllowed('http://anything.test', ['*'])).toBe(true)
  })

  it('allows a listed origin through the Socket.IO/CORS callback', () => {
    const validate = createOriginValidator(['http://localhost:5173'])
    let received
    validate('http://localhost:5173', (error, allowed) => {
      received = { error, allowed }
    })
    expect(received).toEqual({ error: null, allowed: true })
  })

  it('rejects an unlisted origin through the same callback', () => {
    const validate = createOriginValidator(['http://localhost:5173'])
    let received
    validate('http://evil.test', (error, allowed) => {
      received = { error, allowed }
    })
    expect(received.allowed).toBeUndefined()
    expect(received.error).toBeInstanceOf(Error)
    expect(received.error.message).toMatch(/not allowed/)
  })
})
