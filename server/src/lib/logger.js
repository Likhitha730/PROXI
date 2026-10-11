// Minimal structured logger — JSON lines on stdout/stderr, no dependency.
//
// "Safe logging" rules applied here:
//  - only primitives and shallow objects are serialised (no sockets, no
//    requests, no streams) so nothing can circular-reference or dump a whole
//    handshake;
//  - metadata keys that look sensitive (authorization, cookie, uri, password,
//    token, sdp…) are redacted before printing.

import process from 'node:process'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const SENSITIVE_KEY = /(pass(word)?|secret|token|auth|cookie|credential|uri|url|sdp|candidate|key)/i
const REDACTED = '[redacted]'

function isPlainValue(value) {
  return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
}

/** Shallow-redact metadata; nested objects are stringified. */
export function sanitizeMeta(meta) {
  const output = {}
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED
    } else if (isPlainValue(value)) {
      output[key] = value
    } else if (Array.isArray(value)) {
      output[key] = value.filter(isPlainValue)
    } else {
      output[key] = '[object]'
    }
  }
  return output
}

export function createLogger({ level = 'info', scope = 'app', sink = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(levelName, message, meta) {
    if (LEVELS[levelName] > threshold) return
    const record = {
      ts: new Date().toISOString(),
      level: levelName,
      scope,
      message,
      ...sanitizeMeta(meta),
    }
    const line = `${JSON.stringify(record)}\n`
    if (levelName === 'error') process.stderr.write(line)
    else sink.write(line)
  }

  return {
    level,
    scope,
    error: (message, meta) => emit('error', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    info: (message, meta) => emit('info', message, meta),
    debug: (message, meta) => emit('debug', message, meta),
    child: (childScope) => createLogger({ level, scope: `${scope}:${childScope}`, sink }),
  }
}
