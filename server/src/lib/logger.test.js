import { describe, expect, it } from 'vitest'
import { createLogger, sanitizeMeta, scrubSecrets } from './logger.js'

function createSink() {
  const lines = []
  return {
    lines,
    write(chunk) {
      lines.push(chunk)
      return true
    },
  }
}

describe('sanitizeMeta', () => {
  it('redacts sensitive-looking keys', () => {
    const meta = sanitizeMeta({
      mongodbUri: 'mongodb+srv://user:pass@cluster.net',
      cookie: 'session=abc',
      authorization: 'Bearer abc',
      password: 'hunter2',
      sdp: 'v=0...',
    })
    for (const value of Object.values(meta)) expect(value).toBe('[redacted]')
  })

  it('keeps safe primitives and summarises objects', () => {
    expect(sanitizeMeta({ socketId: 'abc', port: 8080, nested: { deep: true } })).toEqual({
      socketId: 'abc',
      port: 8080,
      nested: '[object]',
    })
  })

  it('filters non-primitives out of arrays', () => {
    expect(sanitizeMeta({ transports: ['websocket', { bad: true }] })).toEqual({ transports: ['websocket'] })
  })

  // A secret usually arrives inside somebody else's text — a driver error, a
  // validation reason — so values are scrubbed, not just sensitive-looking keys.
  it('scrubs a connection string hidden in a non-sensitive field', () => {
    const meta = sanitizeMeta({
      reason: 'failed to connect to mongodb://leakuser:SuperSecret@cluster.net:27017/proxi',
      operation: 'savePosition',
    })

    expect(meta.reason).not.toMatch(/SuperSecret|leakuser|cluster\.net/)
    expect(meta.reason).toContain('[redacted-uri]')
    expect(meta.operation).toBe('savePosition')
  })

  it('scrubs credentials out of a plain URL and key=value secrets', () => {
    expect(scrubSecrets('GET https://ada:hunter2@example.com/x failed')).toBe('GET https://[redacted]@example.com/x failed')
    expect(scrubSecrets('password=hunter2 rejected')).toBe('password=[redacted] rejected')
    expect(scrubSecrets('token: abc123')).toBe('token=[redacted]')
    // Ordinary text is left alone.
    expect(scrubSecrets('connect ECONNREFUSED 127.0.0.1:27099')).toBe('connect ECONNREFUSED 127.0.0.1:27099')
  })

  it('scrubs the log message as well as the metadata', () => {
    const sink = createSink()
    const logger = createLogger({ level: 'debug', scope: 'test', sink })
    logger.error('MongoDB connection failed for mongodb+srv://ada:pw@cluster.net/db')
    logger.warn('position store operation failed', { reason: 'mongodb://ada:pw@127.0.0.1:27017/proxi timed out' })

    const output = sink.lines.join('')
    expect(output).not.toMatch(/ada|pw@|cluster\.net|127\.0\.0\.1:27017/)
    expect(output).toContain('[redacted-uri]')
  })
})

describe('createLogger', () => {
  it('writes JSON lines honouring the level threshold', () => {
    const sink = createSink()
    const logger = createLogger({ level: 'info', scope: 'test', sink })

    logger.debug('hidden')
    logger.info('visible', { socketId: 'one' })

    expect(sink.lines).toHaveLength(1)
    const record = JSON.parse(sink.lines[0])
    expect(record).toMatchObject({ level: 'info', scope: 'test', message: 'visible', socketId: 'one' })
    expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
  })

  it('supports scoped children', () => {
    const sink = createSink()
    createLogger({ level: 'debug', scope: 'server', sink }).child('socket').info('hello')
    expect(JSON.parse(sink.lines[0]).scope).toBe('server:socket')
  })
})
