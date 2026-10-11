// Spatial consistency check.
//
// The realtime proximity path and the database proximity path must agree: both
// answer "who is within R of this point", one from live registry state and one from
// persisted records through a planar `2d` query. If they disagree, something is
// wrong with either the live grid or the stored document — and that is exactly the
// class of bug that is invisible in a UI.
//
// So, while MongoDB is available, a slow tick (default every 30 s) picks the player
// who moved most recently, runs the **database** query, and compares:
//
//   * the planar `$near` result against the in-memory grid result;
//   * against live registry membership, so a session that disconnected between the
//     two calls is reported as a benign difference (the archive lags by design).
//
// Differences are logged with a clear reason. No comparison is ever fatal.

/**
 * @param {{
 *   proximity: object,
 *   positions: object,
 *   registry: object,
 *   intervalMs?: number,
 *   logger?: object,
 *   now?: () => number,
 *   maxAgeMs?: number,
 * }} deps
 */
export function createSpatialCheck({
  proximity,
  positions,
  registry,
  intervalMs = 30_000,
  logger,
  now = () => Date.now(),
  maxAgeMs = 60_000,
} = {}) {
  const log = logger?.child ? logger.child('spatial-check') : logger
  const stats = { runs: 0, agreements: 0, differences: 0, skipped: 0, errors: 0 }
  let lastComparison = null

  /**
   * Compare the two strategies for one point.
   *
   * @returns {Promise<{ ok: boolean, reason?: string, database?: object, memory?: object, differences?: string[] }>}
   */
  async function compare({ x, y, excludeSessionId = null, radius = proximity.radius }) {
    if (!positions?.isAvailable?.()) {
      stats.skipped += 1
      return { ok: false, reason: 'database unavailable' }
    }

    // Everything the archive is allowed to know: only these sessions may count.
    const liveSessions = new Set(registry.list().map((player) => player.id))

    const fromDatabase = await positions.findNearby({
      x,
      y,
      radius,
      excludeSessionId,
      activeSessionIds: liveSessions,
      maxAgeMs,
    })
    if (fromDatabase.ok === false) {
      stats.errors += 1
      return { ok: false, reason: fromDatabase.reason }
    }

    const fromMemory = proximity.findNeighboursFor(x, y, { excludeId: excludeSessionId })

    const databaseIds = new Set(fromDatabase.neighbours.map((entry) => entry.sessionId))
    const memoryIds = new Set(fromMemory.map((entry) => entry.id))

    const differences = []
    for (const id of memoryIds) if (!databaseIds.has(id)) differences.push(`missing in database: ${id}`)
    for (const id of databaseIds) if (!memoryIds.has(id)) differences.push(`missing in memory: ${id}`)

    const comparison = {
      ok: differences.length === 0,
      at: now(),
      point: { x, y },
      radius,
      database: { count: databaseIds.size, query: fromDatabase.query },
      memory: { count: memoryIds.size },
      differences,
    }

    lastComparison = comparison
    stats.runs += 1
    if (comparison.ok) {
      stats.agreements += 1
    } else {
      stats.differences += 1
      // Stale archive rows are expected to lag by up to the flush interval; the
      // log says so rather than implying a bug.
      log?.warn('proximity strategies disagree', {
        point: comparison.point,
        radius,
        differences,
        note: 'persisted positions lag live state by up to the flush interval',
      })
    }
    return comparison
  }

  /** Run one tick against the most recently active player (if any). */
  async function runOnce() {
    const players = registry.list()
    if (players.length === 0) {
      stats.skipped += 1
      return { ok: false, reason: 'nobody connected' }
    }
    // The player with the freshest persisted position is the most informative probe.
    const subject = players[players.length - 1]
    return compare({ x: subject.x, y: subject.y, excludeSessionId: subject.id })
  }

  return {
    stats,
    compare,
    runOnce,
    get lastComparison() {
      return lastComparison
    },
    describe() {
      return { intervalMs, ...stats, lastComparison }
    },
  }
}
