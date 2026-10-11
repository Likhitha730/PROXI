// Idempotent index management.
//
// Called on every successful (re)connection, so it must be safe to run against a
// fresh database, a database that already has exactly the right indexes, and one
// that has an older/different index on the same key.
//
// Behaviour
//   * missing index          → created
//   * identical index        → left alone (no DDL, no churn)
//   * same key, new options  → reported as a warning, never dropped automatically
//   * any server error       → reported, never thrown: a database problem must not
//                              stop the realtime server from running

import { compareIndex } from './schema.js'

/** MongoDB error codes for "an index with this key already exists differently". */
const INDEX_CONFLICT_CODES = new Set([85, 86])
const INDEX_ALREADY_EXISTS_CODE = 68

/**
 * @param {{ collection: object, specs: Array<object>, logger?: object }} deps
 * @returns {Promise<{ created: string[], present: string[], conflicts: string[], skipped?: string, error?: string }>}
 */
export async function ensureIndexes({ collection, specs, logger } = {}) {
  const report = { created: [], present: [], conflicts: [] }

  let existing = []
  try {
    // listIndexes is the cheap, read-only way to know what is already there.
    existing = await collection.listIndexes().toArray()
  } catch (error) {
    if (error?.codeName === 'NamespaceNotFound' || error?.code === 26) {
      // Collection does not exist yet: createIndex will create it implicitly.
      report.skipped = 'collection does not exist yet'
      existing = []
    } else {
      report.error = error?.message ?? 'could not list indexes'
      logger?.warn('index inspection failed', { reason: report.error })
      return report
    }
  }

  for (const spec of specs) {
    const current = existing.find((index) => index.name === spec.name) ?? existing.find((index) => {
      const keys = Object.keys(index.key ?? {})
      const wanted = Object.keys(spec.key)
      return keys.length === wanted.length && wanted.every((key) => keys.includes(key))
    })

    if (current) {
      const { matches, differences } = compareSpec(spec, current)
      if (matches) {
        report.present.push(spec.name)
        logger?.debug('index already present', { index: spec.name })
        continue
      }
      report.conflicts.push(`${spec.name} (${differences.join('; ')})`)
      logger?.warn('existing index has different options — leaving it untouched', {
        index: spec.name,
        differences,
      })
      continue
    }

    try {
      const name = await collection.createIndex(spec.key, { name: spec.name, ...spec.options })
      report.created.push(name)
      logger?.info('index created', { index: name, purpose: spec.purpose })
    } catch (error) {
      const code = error?.code
      if (code === INDEX_ALREADY_EXISTS_CODE || INDEX_CONFLICT_CODES.has(code)) {
        // A concurrent startup created it (68), or an incompatible index exists
        // under the same key (85/86). Both are "reported, do not fail".
        report.conflicts.push(`${spec.name} (${error?.codeName ?? code})`)
        logger?.warn('index could not be created — existing index differs', {
          index: spec.name,
          code: error?.codeName ?? code,
        })
        continue
      }
      report.error = error?.message ?? 'index creation failed'
      logger?.warn('index creation failed', { index: spec.name, reason: report.error })
    }
  }

  return report
}

/*
 * Index comparison lives in one place only (`compareIndex`/`sameIndexKey` in
 * schema.js, where the specs are defined), so the rules for "is this existing index
 * the one we want?" cannot drift between the two modules.
 */
const compareSpec = compareIndex
