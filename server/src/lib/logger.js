// Minimal structured logger — JSON lines on stdout/stderr, no dependency.
//
// "Safe logging" rules applied here:
//  - only primitives and shallow objects are serialised (no sockets, no
//    requests, no streams) so nothing can circular-reference or dump a whole
//    handshake;
//  - metadata keys that look sensitive (authorization, cookie, uri, password,
//    token, sdp…) are redacted before printing;
//  - *values* are scrubbed too, because a secret usually arrives inside
//    somebody else's text: a driver error, a validation reason, a rejected
//    payload. A connection string is never printed, whichever field it hides in.

import process from 'node:process'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const SENSITIVE_KEY = /(pass(word)?|secret|token|auth|cookie|credential|uri|url|sdp|candidate|key)/i
const REDACTED = '[redacted]'

/** Credentials inside any URL: scheme://user:password@host → scheme://[redacted]@host */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi
/** A MongoDB connection string, wherever it appears in a longer message. */
const MONGO_URI = /\bmongodb(\+srv)?:\/\/[^\s"'`]+/gi
/** key=value / key: value forms of the usual suspects. */
const SECRET_ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi

/**
 * Scrub secrets out of an arbitrary string.
 *
 * Exported so the redaction rules are testable on their own, and so a caller that
 * is about to log free text can run it through the same rules.
 */
export function scrubSecrets(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(MONGO_URI, '[redacted-uri]')
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
}

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
      output[key] = scrubSecrets(value)
    } else if (Array.isArray(value)) {
      output[key] = value.filter(isPlainValue).map(scrubSecrets)
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
      // The message too: a driver error string can carry the URI it failed on.
      message: scrubSecrets(message),
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
