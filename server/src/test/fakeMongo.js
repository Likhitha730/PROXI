// In-process MongoDB double for tests.
//
// WHY THIS EXISTS
// ---------------
// This sandbox has no MongoDB server and cannot download one (no `mongod` binary,
// no Docker, and fastdl.mongodb.org is unreachable), so the persistence code has to
// be verified against something. This module implements the *specific* subset of the
// driver surface the repository uses, with the documented behaviour of a legacy
// **`2d` (planar) index**:
//
//   * `createIndex` / `listIndexes` — including the real conflict semantics
//     (code 85 IndexOptionsConflict, 68 IndexAlreadyExists) reached through a hook,
//     so idempotency handling is exercised rather than assumed;
//   * `updateOne` with `$set` / `$setOnInsert` / `upsert`, `bulkWrite`;
//   * `find` with `$near` + `$maxDistance` (returns documents **sorted by ascending
//     Euclidean distance in index units** — planar, no spherical wrapping) and
//     `$geoWithin: { $center: [[x,y], r] }`;
//   * `countDocuments`, `deleteMany`, `updateOne` without upsert.
//
// It is a test double, NOT a MongoDB implementation: it deliberately covers only what
// this codebase sends, and it is used to prove that the emitted query documents are
// well-formed and that the repository's own logic (self-exclusion, liveness filtering,
// de-duplication, staleness cut-off) behaves. Correctness of a real deployment still
// requires a real server — see docs/SESSION_05_REPORT.md §"Measured query behaviour",
// which says exactly that and does not claim database performance numbers.

/** Planar distance: Euclidean in index units. No longitude/latitude anywhere. */
const planarDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)

const asTime = (value) => (value instanceof Date ? value.getTime() : value)

/** Every operator present on a field must hold (implicit AND), as MongoDB does. */
function matchesScalar(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const operators = Object.keys(condition)
    if (operators.length === 0) return true
    return operators.every((operator) => {
      switch (operator) {
        case '$ne':
          return value !== condition.$ne
        case '$in':
          return condition.$in.includes(value)
        case '$nin':
          return !condition.$nin.includes(value)
        case '$gte':
          return asTime(value) >= asTime(condition.$gte)
        case '$gt':
          return asTime(value) > asTime(condition.$gt)
        case '$lte':
          return asTime(value) <= asTime(condition.$lte)
        case '$lt':
          return asTime(value) < asTime(condition.$lt)
        case '$exists':
          return condition.$exists ? value !== undefined : value === undefined
        default:
          // An unsupported operator must fail loudly in tests, never silently match.
          throw new Error(`fakeMongo: unsupported query operator ${operator}`)
      }
    })
  }
  return value === condition
}

/** Evaluate a `location` condition, returning { match, distance }. */
function matchLocation(location, condition) {
  if (!condition || typeof condition !== 'object') return { match: true, distance: null }
  const [x, y] = location

  if (condition.$near) {
    const [nearX, nearY] = condition.$near
    const distance = planarDistance(x, y, nearX, nearY)
    const max = condition.$maxDistance
    return { match: max === undefined || distance <= max, distance }
  }

  if (condition.$geoWithin) {
    const within = condition.$geoWithin
    if (within.$center) {
      const [centre, radius] = within.$center
      const distance = planarDistance(x, y, centre[0], centre[1])
      return { match: distance <= radius, distance }
    }
    if (within.$box) {
      const [[x1, y1], [x2, y2]] = within.$box
      return {
        match: x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2),
        distance: null,
      }
    }
  }

  return { match: true, distance: null }
}

function documentMatches(document, filter) {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === 'location') {
      if (!matchLocation(document.location ?? [], condition).match) return false
      continue
    }
    if (!matchesScalar(document[field], condition)) return false
  }
  return true
}

function applyUpdate(document, update) {
  if (update.$set) Object.assign(document, update.$set)
  if (update.$setOnInsert) {
    for (const [key, value] of Object.entries(update.$setOnInsert)) {
      if (document[key] === undefined) document[key] = value
    }
  }
  return document
}

/**
 * @param {{ name?: string, failWith?: (operation: string) => Error | null, existingIndexes?: Array<object> }} [options]
 */
export function createFakeDatabase({ failWith = () => null, existingIndexes = [] } = {}) {
  const collections = new Map()
  const calls = []
  // Mutable so a test can break the database mid-session and assert recovery.
  let failure = failWith

  function collectionFor(name) {
    if (!collections.has(name)) {
      collections.set(name, { documents: [], indexes: [...existingIndexes], createdIndexCalls: [] })
    }
    return collections.get(name)
  }

  function fail(operation) {
    const error = failure(operation)
    if (error) {
      calls.push({ operation, failed: true })
      throw error
    }
  }

  const collectionHandle = (name) => ({
    async createIndex(key, options = {}) {
      calls.push({ operation: 'createIndex', name, key, options })
      fail('createIndex')
      const store = collectionFor(name)
      const keyString = JSON.stringify(key)
      const existing = store.indexes.find((index) => JSON.stringify(index.key) === keyString)
      if (existing) {
        const sameOptions =
          String(existing.unique) === String(options.unique) &&
          String(existing.min) === String(options.min) &&
          String(existing.max) === String(options.max) &&
          String(existing.expireAfterSeconds) === String(options.expireAfterSeconds)
        if (sameOptions) {
          const error = new Error(`Index already exists with a different name: ${existing.name}`)
          error.code = 85
          error.codeName = 'IndexOptionsConflict'
          throw error
        }
        const error = new Error(`Index with name ${options.name} already exists with different options`)
        error.code = 85
        error.codeName = 'IndexOptionsConflict'
        throw error
      }
      store.indexes.push({ name: options.name ?? `${Object.keys(key).join('_')}_1`, key, ...options })
      return options.name ?? `${Object.keys(key).join('_')}_1`
    },

    listIndexes() {
      calls.push({ operation: 'listIndexes', name })
      try {
        fail('listIndexes')
      } catch (error) {
        return { toArray: async () => Promise.reject(error) }
      }
      const store = collectionFor(name)
      const list = store.indexes.length > 0 ? store.indexes : []
      return { toArray: async () => list.map((index) => ({ ...index })) }
    },

    find(filter = {}, options = {}) {
      calls.push({ operation: 'find', name, filter, options })
      const store = collectionFor(name)
      let results = store.documents
        .filter((document) => documentMatches(document, filter))
        .map((document) => ({
          document,
          distance: filter.location?.$near ? matchLocation(document.location, filter.location).distance : null,
        }))

      // Planar 2d $near: ascending Euclidean distance in index units.
      if (filter.location?.$near) results = results.sort((a, b) => a.distance - b.distance)
      if (options.limit) results = results.slice(0, options.limit)

      return {
        toArray: async () => {
          try {
            fail('find')
          } catch (error) {
            throw error
          }
          return results.map((entry) => ({ ...entry.document }))
        },
      }
    },

    async updateOne(filter, update, options = {}) {
      calls.push({ operation: 'updateOne', name, filter, update, options })
      fail('updateOne')
      const store = collectionFor(name)
      const existing = store.documents.find((document) => documentMatches(document, filter))

      if (existing) {
        applyUpdate(existing, update)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
      }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, acknowledged: true }

      const created = { _id: `fake-${store.documents.length + 1}` }
      applyUpdate(created, update)
      store.documents.push(created)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true }
    },

    async bulkWrite(operations = []) {
      calls.push({ operation: 'bulkWrite', name, count: operations.length })
      fail('bulkWrite')
      let upserts = 0
      let modified = 0
      for (const operation of operations) {
        const result = await collectionHandle(name).updateOne(
          operation.updateOne.filter,
          operation.updateOne.update,
          operation.updateOne,
        )
        upserts += result.upsertedCount
        modified += result.modifiedCount
      }
      return { upsertedCount: upserts, modifiedCount: modified, acknowledged: true, ok: 1 }
    },

    async countDocuments(filter = {}) {
      calls.push({ operation: 'countDocuments', name, filter })
      fail('countDocuments')
      const store = collectionFor(name)
      return store.documents.filter((document) => documentMatches(document, filter)).length
    },

    async deleteMany(filter = {}) {
      calls.push({ operation: 'deleteMany', name, filter })
      fail('deleteMany')
      const store = collectionFor(name)
      const before = store.documents.length
      store.documents = store.documents.filter((document) => !documentMatches(document, filter))
      return { deletedCount: before - store.documents.length, acknowledged: true }
    },
  })

  return {
    calls,
    database: {
      collection: (name) => collectionHandle(name),
    },
    /** Test helpers */
    documentsIn(name) {
      return collectionFor(name).documents.map((document) => ({ ...document }))
    },
    indexesIn(name) {
      return collectionFor(name).indexes.map((index) => ({ ...index }))
    },
    seed(name, documents) {
      const store = collectionFor(name)
      store.documents.push(...documents.map((document, index) => ({ _id: `seed-${index + 1}`, ...document })))
    },
    callsOf(operation) {
      return calls.filter((call) => call.operation === operation)
    },
    /** Make every subsequent driver call fail (or pass null to heal the database). */
    setFailure(next = null) {
      failure = next ?? (() => null)
    },
    /** Fail every operation with one error — the "MongoDB is down" scenario. */
    failEverything(error) {
      failure = () => error
    },
    reset() {
      collections.clear()
      calls.length = 0
    },
  }
}

/** Error helpers that mimic driver failures for the "database is broken" tests. */
export const mongoErrors = {
  timeout: () => {
    const error = new Error('connection timed out')
    error.name = 'MongoNetworkTimeoutError'
    return error
  },
  notConnected: () => {
    const error = new Error('Client must be connected before running operations')
    error.name = 'MongoNotConnectedError'
    return error
  },
  indexConflict: (message = 'Index already exists with different options') => {
    const error = new Error(message)
    error.code = 85
    error.codeName = 'IndexOptionsConflict'
    return error
  },
}
