// Recording logger for tests: captures every record and writes nothing.
//
// Children share the parent's record array, so one assertion can see everything a
// code path logged — including the guarantee that no secret ever reaches a log line.

import { createLogger } from '../lib/logger.js'

const SILENT_SINK = { write() {} }

/**
 * @param {{ records?: Array<object>, sink?: { write: Function }, scope?: string }} [options]
 */
export function createWorldLogger({ records = [], sink = SILENT_SINK, scope = 'test' } = {}) {
  const inner = createLogger({ level: 'debug', scope, sink })
  const emit = (level) => (message, meta) => {
    records.push({ level, message, meta, scope })
    inner[level](message, meta)
  }

  return {
    records,
    scope,
    level: 'debug',
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    /** Same record array, different scope label. */
    child: (childScope) => createWorldLogger({ records, sink, scope: childScope }),
  }
}
