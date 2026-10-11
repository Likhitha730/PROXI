/**
 * ProxiSpeak realtime protocol — the single source of truth for the wire
 * contract between `client/` and `server/`.
 *
 * Both packages import this file, so an event name or payload shape can never
 * drift between the two sides; renaming an event is a one-line change here.
 *
 * Everything in this module is pure: no Node APIs, no DOM, no socket library.
 * The server is authoritative — the validators here are used by the server to
 * decide what to accept, and by the client to fail fast on its own output.
 *
 * Conventions
 *  - Event names are namespaced by the entity they concern: `player:*`,
 *    `players:*`, `server:*`.
 *  - A "player" is always the full record:
 *      { id, name, x, y, dir, moving, joinedAt }
 *    `player:moved` is the one deliberate exception: it carries only the fields
 *    that change at 15 Hz, to keep the hot path small.
 *  - Unknown events are ignored (never an error) on both sides.
 */

export const PROTOCOL_VERSION = 1

/** Every event name in the protocol. Import these instead of typing strings. */
export const EVENTS = Object.freeze({
  // client -> server
  JOIN: 'player:join',
  MOVE: 'player:move',

  // server -> client
  SNAPSHOT: 'players:snapshot',
  JOINED: 'player:joined',
  MOVED: 'player:moved',
  LEFT: 'player:left',
  PROXIMITY: 'proximity:update',
  ERROR: 'server:error',
})

/** Event names grouped by direction (used by tests and documentation). */
export const CLIENT_TO_SERVER_EVENTS = Object.freeze([EVENTS.JOIN, EVENTS.MOVE])
export const SERVER_TO_CLIENT_EVENTS = Object.freeze([
  EVENTS.SNAPSHOT,
  EVENTS.JOINED,
  EVENTS.MOVED,
  EVENTS.LEFT,
  EVENTS.PROXIMITY,
  EVENTS.ERROR,
])
export const ALL_EVENTS = Object.freeze([...CLIENT_TO_SERVER_EVENTS, ...SERVER_TO_CLIENT_EVENTS])

/**
 * Numeric limits shared by both sides.
 *
 * These mirror the simulation constants in `client/src/render/engine.js`
 * (WALK_SPEED 205 u/s) and the geometry in `client/src/world/worldData.js`
 * (2560 x 1600 world). A client-side parity test asserts the world numbers
 * still match the map data, so the server can validate positions without
 * importing the renderer.
 */
export const LIMITS = Object.freeze({
  /** Display name: 1–24 characters after trimming. */
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 24,
  /** Letters (incl. accents), digits, spaces and a few safe separators. */
  NAME_PATTERN: /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u,

  /** Logical world size, matching WORLD in worldData.js. */
  WORLD_WIDTH: 2560,
  WORLD_HEIGHT: 1600,
  /** Walkable inset: WORLD.margin (24) + wallThickness/2 (8). */
  WALKABLE_X: 32,
  WALKABLE_Y: 32,
  WALKABLE_WIDTH: 2496,
  WALKABLE_HEIGHT: 1536,

  /** Movement update budget, enforced on both sides. */
  MOVE_UPDATES_PER_SECOND: 15,
  MOVE_BURST: 5,
  /** Server anti-teleport: max u/s used to size the per-update allowance. */
  MAX_SPEED_UNITS_PER_SECOND: 205,
  /** Extra allowance per update covers easing, lag and clock jitter. */
  MOVE_ALLOWANCE_SLACK: 48,
  /** `clientTs` may not be more than this far in the future. */
  CLOCK_SKEW_MS: 2000,

  /** Client-side interpolation of remote players (see docs/ARCHITECTURE.md). */
  INTERPOLATION_DELAY_MS: 120,
  EXTRAPOLATION_LIMIT_MS: 150,

  /**
   * Proximity: users within this many world units are "nearby" (they are the ones
   * the audio sessions will connect). 100 u is roughly two desk widths — close
   * enough that talking is natural, far enough not to trigger across the office.
   */
  PROXIMITY_RADIUS: 100,
  /** Proximity recalculation budget per client. */
  PROXIMITY_UPDATES_PER_SECOND: 4,
  /** Recompute only after the player has moved this far since the last result. */
  PROXIMITY_MIN_MOVEMENT: 8,
  /** A neighbour must be at least this close to count as "in range" again. */
  PROXIMITY_HYSTERESIS: 12,
  /** Cap on neighbours returned in one proximity result. */
  PROXIMITY_MAX_NEIGHBOURS: 16,

  /** Cap on simultaneous players per room. */
  MAX_PLAYERS_PER_ROOM: 24,
})

/**
 * Spawn points, mirrored from `SPAWNS` in worldData.js (spawn id order matters:
 * the server hands out the point farthest from everyone already in the room).
 */
export const SPAWN_POINTS = Object.freeze([
  Object.freeze({ id: 'entrance', x: 1280, y: 1500 }),
  Object.freeze({ id: 'workspace', x: 920, y: 800 }),
  Object.freeze({ id: 'meeting', x: 640, y: 300 }),
])

/**
 * One neighbour entry inside a proximity result.
 *
 * @typedef {{
 *   id: string, name: string, x: number, y: number, distance: number, nearby: true
 * }} ProximityNeighbour
 */

/**
 * The proximity result: who is within `radius` of a player, with their current
 * positions and exact planar distances. Sorted nearest first, self excluded, and
 * de-duplicated by id — the internal shape is the wire shape, so what the server
 * computes is exactly what it broadcasts.
 *
 * @param {{
 *   id: string,
 *   radius: number,
 *   neighbours: Array<ProximityNeighbour>,
 *   at?: number,
 * }} input
 */
export function createProximityResult({ id, radius, neighbours, at = Date.now() }) {
  return {
    id,
    radius,
    neighbours: neighbours.map((neighbour) => ({
      id: neighbour.id,
      name: neighbour.name,
      x: roundCoord(neighbour.x),
      y: roundCoord(neighbour.y),
      distance: roundCoord(neighbour.distance),
      nearby: true,
    })),
    at,
  }
}

/**
 * True when two proximity results would look the same to a client: same set of
 * ids with the same distance bucket. Used to throttle broadcasts — a player
 * drifting 0.4 u must not generate traffic.
 */
export function proximityResultsEqual(a, b, bucketUnits = 1) {
  if (!a || !b) return false
  if (a.radius !== b.radius) return false
  if (a.neighbours.length !== b.neighbours.length) return false
  for (let index = 0; index < a.neighbours.length; index += 1) {
    const left = a.neighbours[index]
    const right = b.neighbours[index]
    if (left.id !== right.id) return false
    if (Math.abs(left.distance - right.distance) >= bucketUnits) return false
  }
  return true
}

/** Error codes carried by `server:error`. */
export const ERROR_CODES = Object.freeze({
  INVALID_NAME: 'invalid_name',
  INVALID_PAYLOAD: 'invalid_payload',
  INVALID_POSITION: 'invalid_position',
  RATE_LIMITED: 'rate_limited',
  ROOM_FULL: 'room_full',
  JOIN_REQUIRED: 'join_required',
  INTERNAL: 'internal_error',
})

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** Round to 2 decimals: sub-pixel precision is noise on the wire. */
export const roundCoord = (value) => Math.round(value * 100) / 100

/**
 * Validate and normalise a display name.
 *
 * Rejects: non-strings, empty/whitespace-only names, names over the length
 * limit, control characters and anything outside the allowed charset (which
 * keeps log injection, markup and homoglyph tricks off the wire).
 *
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function normaliseName(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'must be a string' }
  // Collapse runs of whitespace so "  Ada   Lovelace " -> "Ada Lovelace".
  const name = input.replace(/\s+/g, ' ').trim()
  if (name.length < LIMITS.NAME_MIN_LENGTH) return { ok: false, reason: 'must not be empty' }
  if (name.length > LIMITS.NAME_MAX_LENGTH) return { ok: false, reason: `longer than ${LIMITS.NAME_MAX_LENGTH} characters` }
  if (!LIMITS.NAME_PATTERN.test(name)) return { ok: false, reason: 'contains unsupported characters' }
  return { ok: true, value: name }
}

/** True when a point is inside the walkable area of the world. */
export function isInsideWorld(x, y) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return false
  return (
    x >= LIMITS.WALKABLE_X &&
    y >= LIMITS.WALKABLE_Y &&
    x <= LIMITS.WALKABLE_X + LIMITS.WALKABLE_WIDTH &&
    y <= LIMITS.WALKABLE_Y + LIMITS.WALKABLE_HEIGHT
  )
}

/**
 * Validate a `player:move` payload.
 *
 * `previous` (the server's last accepted position for that player, or the spawn
 * point) sizes the anti-teleport allowance: no move may cover more ground than a
 * player could really walk in the elapsed time, plus a fixed slack.
 *
 * @param {unknown} payload
 * @param {{ x: number, y: number, at: number }|null} previous
 * @param {{ now?: number }} [options]
 * @returns {{ ok: true, value: {x:number,y:number,dir:number,moving:boolean,clientTs:number,elapsedMs:number} }
 *          | { ok: false, code: string, reason: string }}
 */
export function validateMove(payload, previous = null, options = {}) {
  if (!payload || typeof payload !== 'object') return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'payload must be an object' }

  const { x, y, dir, moving, clientTs } = payload
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'x and y must be finite numbers' }
  }
  if (!isInsideWorld(x, y)) {
    return { ok: false, code: ERROR_CODES.INVALID_POSITION, reason: 'outside the walkable world' }
  }
  if (dir !== undefined && !isFiniteNumber(dir)) {
    return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'dir must be a finite number' }
  }
  if (moving !== undefined && typeof moving !== 'boolean') {
    return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'moving must be a boolean' }
  }
  const now = options.now ?? Date.now()
  if (clientTs !== undefined) {
    if (!isFiniteNumber(clientTs)) {
      return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'clientTs must be a finite number' }
    }
    if (clientTs - now > LIMITS.CLOCK_SKEW_MS) {
      return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, reason: 'clientTs is in the future' }
    }
  }

  let elapsedMs = 0
  if (previous) {
    const distance = Math.hypot(x - previous.x, y - previous.y)
    elapsedMs = Math.max(0, now - previous.at)
    const allowance =
      (LIMITS.MAX_SPEED_UNITS_PER_SECOND * Math.max(elapsedMs, 1000 / LIMITS.MOVE_UPDATES_PER_SECOND)) / 1000 +
      LIMITS.MOVE_ALLOWANCE_SLACK
    if (distance > allowance) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_POSITION,
        reason: `moved ${Math.round(distance)}u in ${Math.round(elapsedMs)}ms (limit ${Math.round(allowance)}u)`,
      }
    }
  }

  return {
    ok: true,
    value: {
      x: roundCoord(x),
      y: roundCoord(y),
      // Facing is presentation-only, so a missing value keeps the previous one.
      dir: dir === undefined ? null : roundCoord(dir),
      moving: moving === undefined ? false : moving,
      clientTs: clientTs === undefined ? now : clientTs,
      elapsedMs,
    },
  }
}

/** The canonical full player record. */
export function createPlayerRecord({ id, name, x, y, dir = Math.PI / 2, moving = false, joinedAt = Date.now() }) {
  return Object.freeze({ id, name, x: roundCoord(x), y: roundCoord(y), dir, moving: Boolean(moving), joinedAt })
}

/** `players:snapshot` — sent to a client immediately after it joins. */
export function createSnapshot({ self, players, room }) {
  return {
    version: PROTOCOL_VERSION,
    self: createPlayerRecord(self),
    players: players.map((player) => createPlayerRecord(player)),
    room: { id: room.id, maxPlayers: LIMITS.MAX_PLAYERS_PER_ROOM },
    world: { width: LIMITS.WORLD_WIDTH, height: LIMITS.WORLD_HEIGHT },
    moveHz: LIMITS.MOVE_UPDATES_PER_SECOND,
    serverTs: Date.now(),
  }
}

/** `player:moved` — the 15 Hz delta. */
export function createMoveUpdate({ id, x, y, dir, moving, serverTs = Date.now() }) {
  return { id, x: roundCoord(x), y: roundCoord(y), dir, moving: Boolean(moving), serverTs }
}

/** `server:error` — recoverable problems; `data` carries a correction when there is one. */
export function createError(code, message, data = undefined) {
  return data === undefined ? { code, message } : { code, message, data }
}

/**
 * Pick a spawn point for a new player: the point farthest from everybody else
 * already in the room, so two people never materialise on top of each other.
 */
export function pickSpawnPoint(existing = []) {
  if (existing.length === 0) return SPAWN_POINTS[0]
  let best = SPAWN_POINTS[0]
  let bestScore = -1
  for (const point of SPAWN_POINTS) {
    let nearest = Infinity
    for (const player of existing) {
      nearest = Math.min(nearest, Math.hypot(player.x - point.x, player.y - point.y))
    }
    if (nearest > bestScore) {
      bestScore = nearest
      best = point
    }
  }
  return best
}
