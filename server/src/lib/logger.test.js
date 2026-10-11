import { describe, expect, it } from 'vitest'
import { createLogger, sanitizeMeta } from './logger.js'

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
