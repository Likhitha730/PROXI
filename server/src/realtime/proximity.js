// Proximity engine — who is close enough to talk to.
//
// Strategy: a uniform spatial grid over the world (the same approach the client
// uses for collision) rather than an all-pairs scan. Insert every connected player
// once per recompute, then query a 3x3 neighbourhood of cells around the listener:
// with a 100 u radius and 100 u cells that neighbourhood is guaranteed to contain
// every possible neighbour, so the result is exact, not approximate.
//
// The grid is rebuilt from the registry on demand. With the room capped at 24
// players the rebuild is trivial (and measured — see docs/SESSION_05_REPORT.md),
// and it keeps the engine free of incremental-update bugs: presence is small and
// authoritative, so it is simply read.
//
// Guarantees
//   * self is never a neighbour;
//   * no duplicate ids (a grid cell can only be visited once per query);
//   * only players currently in the registry — a disconnected session disappears
//     from proximity results immediately, even though its persisted record remains
//     in MongoDB as history;
//   * distances are exact planar distances in world units, nearest first;
//   * results include each neighbour's current position and distance (the
//     documented internal result is the shape that is broadcast).

import {
  LIMITS,
  createProximityResult,
  proximityResultsEqual,
  roundCoord,
} from '../../../shared/protocol.js'

const CELL_SIZE = LIMITS.PROXIMITY_RADIUS

/** Build a fresh grid over the given players: Map<"cx,cy", player[]>. */
function buildGrid(players) {
  const grid = new Map()
  for (const player of players) {
    const key = `${Math.floor(player.x / CELL_SIZE)},${Math.floor(player.y / CELL_SIZE)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(player)
    else grid.set(key, [player])
  }
  return grid
}

/**
 * Compute the neighbours of one player at (x, y).
 *
 * @param {{ x: number, y: number, id: string }} origin
 * @param {Array<{ id: string, name: string, x: number, y: number }>} players
 * @param {{ radius: number, grid?: Map<string, Array<object>>, maxNeighbours?: number, hysteresis?: number, previous?: Set<string>, exact?: boolean }} options
 * @returns {{ neighbours: Array<{id:string,name:string,x:number,y:number,distance:number}>, saturates: boolean }}
 */
export function findNeighbours(origin, players, options) {
  const {
    radius,
    maxNeighbours = LIMITS.PROXIMITY_MAX_NEIGHBOURS,
    hysteresis = 0,
    previous = null,
    grid = null,
  } = options

  const structure = grid ?? buildGrid(players)
  const innerRadiusSquared = radius * radius
  // Hysteresis: players already nearby stay nearby until they leave radius + slack.
  const outerRadius = radius + hysteresis
  const outerRadiusSquared = outerRadius * outerRadius

  const centreX = Math.floor(origin.x / CELL_SIZE)
  const centreY = Math.floor(origin.y / CELL_SIZE)
  const collected = []

  // 3x3 cell neighbourhood: every point within `outerRadius` is guaranteed to be
  // inside it, because the cell size equals the base radius.
  for (let cellX = centreX - 1; cellX <= centreX + 1; cellX += 1) {
    for (let cellY = centreY - 1; cellY <= centreY + 1; cellY += 1) {
      const bucket = structure.get(`${cellX},${cellY}`)
      if (!bucket) continue
      for (const player of bucket) {
        if (player.id === origin.id) continue // never our own neighbour
        const dx = player.x - origin.x
        const dy = player.y - origin.y
        const squared = dx * dx + dy * dy
        // A player already in range is kept until the outer (hysteresis) radius.
        const staysNearby = Boolean(previous?.has(player.id))
        const limitSquared = staysNearby ? outerRadiusSquared : innerRadiusSquared
        if (squared > limitSquared) continue
        collected.push({
          id: player.id,
          name: player.name,
          x: player.x,
          y: player.y,
          distance: Math.sqrt(squared),
        })
      }
    }
  }

  collected.sort((a, b) => a.distance - b.distance)

  const saturates = collected.length > maxNeighbours
  return { neighbours: saturates ? collected.slice(0, maxNeighbours) : collected, saturates }
}

/**
 * @param {{
 *   registry: object,
 *   radius?: number,
 *   intervalMs?: number,
 *   minMovement?: number,
 *   hysteresis?: number,
 *   onUpdate?: (socketId: string, result: object, meta: object) => void,
 *   now?: () => number,
 * }} deps
 */
export function createProximityEngine({
  registry,
  radius = LIMITS.PROXIMITY_RADIUS,
  intervalMs = 1000 / LIMITS.PROXIMITY_UPDATES_PER_SECOND,
  minMovement = LIMITS.PROXIMITY_MIN_MOVEMENT,
  hysteresis = LIMITS.PROXIMITY_HYSTERESIS,
  onUpdate,
  now = () => Date.now(),
} = {}) {
  /** Per-socket bookkeeping: last result, last computation time, last position. */
  const stateBySocket = new Map()

  const stats = {
    computations: 0,
    broadcasts: 0,
    throttled: 0,
    unchanged: 0,
  }

  function stateFor(socketId) {
    let state = stateBySocket.get(socketId)
    if (!state) {
      state = { result: null, computedAt: 0, lastX: Number.NaN, lastY: Number.NaN, neighbours: new Set() }
      stateBySocket.set(socketId, state)
    }
    return state
  }

  /**
   * Compute (and optionally publish) the proximity result for one socket.
   *
   * Throttling rules for the common case — the listener must have both waited
   * `intervalMs` (4 Hz) and moved at least `minMovement` before we recompute:
   *   * `force` (join/leave, so membership changes are never delayed) skips both;
   *   * `affected` (someone *else* moved nearby) skips the movement budget, because a
   *     stationary listener must still learn that a player walked into range, but it
   *     only publishes when the neighbour set actually changed or the 4 Hz interval
   *     allows a distance refresh.
   *
   * @returns {{ result: object|null, broadcast: boolean, reason: string }}
   */
  function update(socketId, { force = false, publish = true, affected = false, grid: sharedGrid = null } = {}) {
    const player = registry.get(socketId)
    if (!player) {
      stateBySocket.delete(socketId)
      return { result: null, broadcast: false, reason: 'not_registered' }
    }

    const state = stateFor(socketId)
    const at = now()
    const moved = Math.hypot(player.x - state.lastX, player.y - state.lastY)
    const firstComputation = state.result === null

    const intervalOk = at - state.computedAt >= intervalMs
    const movementOk = !Number.isFinite(moved) || moved >= minMovement

    // Two independent throttles, both skipped for a forced (membership) update. An
    // `affected` listener skips the movement budget — its own position did not change,
    // but a neighbour's did, and that is exactly the event it must not miss.
    if (!force && !firstComputation && !affected) {
      if (!intervalOk) {
        stats.throttled += 1
        return { result: state.result, broadcast: false, reason: 'interval' }
      }
      if (!movementOk) {
        stats.throttled += 1
        return { result: state.result, broadcast: false, reason: 'stationary' }
      }
    }

    // Grid built from live registry state only. Reused across the listeners of a
    // single sweep (`updateAll`) and across the players affected by one move, because
    // positions cannot change while these synchronous loops run.
    const players = registry.list()
    const grid = sharedGrid ?? buildGrid(players)
    const { neighbours, saturates } = findNeighbours(
      { id: player.id, x: player.x, y: player.y },
      players,
      { radius, grid, hysteresis, previous: state.neighbours },
    )

    const nextIds = new Set(neighbours.map((neighbour) => neighbour.id))
    const changed =
      nextIds.size !== state.neighbours.size ||
      [...nextIds].some((id) => !state.neighbours.has(id))

    const result = createProximityResult({
      id: player.id,
      radius,
      neighbours: neighbours.map((neighbour) => ({ ...neighbour, nearby: true })),
      at,
    })

    state.result = result
    state.computedAt = at
    state.lastX = player.x
    state.lastY = player.y
    state.neighbours = nextIds
    stats.computations += 1

    /*
     * Publish when
     *   * the caller forced it (a join or a leave must never wait), or
     *   * a neighbour entered or left the radius (the interesting event), or
     *   * the listener moved at least PROXIMITY_MIN_MOVEMENT, which refreshes the
     *     distances a client draws — bounded by the interval throttle above, so the
     *     worst case is PROXIMITY_UPDATES_PER_SECOND messages per second.
     * The first computation for a socket always publishes.
     */
    const movedEnough = firstComputation || movementOk
    const shouldBroadcast =
      publish && (force || changed || (affected ? intervalOk : movedEnough))
    if (publish && !shouldBroadcast) stats.unchanged += 1
    if (shouldBroadcast) {
      stats.broadcasts += 1
      onUpdate?.(socketId, result, { saturates, changed })
    }

    return { result, broadcast: shouldBroadcast, reason: changed ? 'changed' : 'refreshed' }
  }

  /**
   * Everything that must be recomputed after `socketId` moved: itself, plus every
   * other player whose neighbourhood the move could have changed — those within
   * radius + hysteresis of the new position, and the players who were its neighbours
   * a moment ago (someone may just have walked *out* of range).
   */
  function updateAffected(socketId) {
    const player = registry.get(socketId)
    if (!player) return update(socketId, { publish: false })

    const state = stateFor(socketId)
    const previousNeighbourIds = new Set(state.neighbours)

    // One grid for the whole update: the mover, the surrounding query and every
    // affected listener all read the same snapshot of live positions.
    const players = registry.list()
    const grid = buildGrid(players)

    // The mover itself: its own result is what its client draws.
    const moverUpdate = update(socketId, { grid })
    // A wider query than the radius, so a player sitting just outside it is still
    // recomputed when the mover crosses in or out of *their* range.
    const { neighbours: surrounding } = findNeighbours(
      { id: player.id, x: player.x, y: player.y },
      players,
      { radius: radius + hysteresis, maxNeighbours: Number.MAX_SAFE_INTEGER, grid },
    )

    const affectedIds = new Set(surrounding.map((neighbour) => neighbour.id))
    for (const id of previousNeighbourIds) affectedIds.add(id)

    const affected = []
    for (const playerId of affectedIds) {
      if (playerId === player.id) continue
      const otherSocketId = registry.socketIdFor(playerId)
      if (!otherSocketId || !registry.has(otherSocketId)) continue
      affected.push({ socketId: otherSocketId, ...update(otherSocketId, { affected: true, grid }) })
    }

    return { mover: moverUpdate, affected }
  }

  return {
    radius,
    intervalMs,
    minMovement,
    hysteresis,
    stats,
    updateAffected,

    /**
     * Recompute for every connected player (used after a join or a leave).
     *
     * One grid is built for the whole sweep: every listener is answered from the same
     * snapshot of live positions, which is both cheaper and more consistent than
     * rebuilding it per listener.
     */
    updateAll({ publish = true } = {}) {
      const results = []
      const grid = buildGrid(registry.list())
      for (const [socketId] of stateBySocket) {
        if (!registry.get(socketId)) {
          stateBySocket.delete(socketId)
          continue
        }
        results.push({ socketId, ...update(socketId, { force: true, publish, grid }) })
      }
      return results
    },

    update,

    /** Register a socket so `updateAll` includes it before its first move. */
    track(socketId) {
      stateFor(socketId)
      return update(socketId, { force: true, publish: false }).result
    },

    forget(socketId) {
      return stateBySocket.delete(socketId)
    },

    /** Current result for a socket (internal shape, safe to serialise). */
    resultFor(socketId) {
      return stateBySocket.get(socketId)?.result ?? null
    },

    /** Diagnostics: how many sockets are being tracked and the last radius used. */
    describe() {
      return { tracked: stateBySocket.size, radius, stats: { ...stats } }
    },

    reset() {
      stateBySocket.clear()
      stats.computations = 0
      stats.broadcasts = 0
      stats.throttled = 0
      stats.unchanged = 0
    },

    /** Exposed for tests and for the spatial consistency check. */
    findNeighboursFor(x, y, { excludeId = null, players = null } = {}) {
      const list = players ?? registry.list()
      const { neighbours } = findNeighbours({ id: excludeId ?? '__none__', x, y }, list, { radius, grid: buildGrid(list) })
      return neighbours.map((neighbour) => ({ ...neighbour, distance: roundCoord(neighbour.distance) }))
    },

    /** True when two results describe the same neighbourhood (distance-bucketed). */
    isSameAsPrevious(socketId, result) {
      return proximityResultsEqual(stateBySocket.get(socketId)?.result, result)
    },
  }
}
