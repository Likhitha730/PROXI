// Socket.IO presence handlers — the multiplayer server for this session.
//
// Scope: player registry, join/snapshot, validated + rate-limited movement
// broadcast, and disconnect cleanup. MongoDB persistence and WebRTC signalling
// are explicitly NOT implemented yet (later sessions).
//
// Design rules enforced here
//  * the server is authoritative: a position only changes through the registry,
//    and only after validation;
//  * identity is never taken from the client — the player id is minted by the
//    server, and any `id`/`room` a client sends is ignored;
//  * every socket registers its listeners exactly once (the connection handler
//    runs once per socket), and there is a single `disconnect` handler;
//  * one socket can never produce two players: a second `player:join` is a
//    rename, and a repeat of the same name is a no-op;
//  * every inbound payload is validated, and the movement rate is capped.

import {
  ERROR_CODES,
  EVENTS,
  LIMITS,
  createError,
  createMoveUpdate,
  createSnapshot,
  normaliseName,
  validateMove,
} from '../../../shared/protocol.js'
import { createPlayerRegistry } from '../realtime/registry.js'
import { createTokenBucket } from '../realtime/rateLimiter.js'

const TRANSPORT_UPGRADE = 'upgrade'

/** The only room this server hosts. Clients cannot choose or join another. */
export const DEFAULT_ROOM_ID = 'proxispeak-lobby'

/** Stop talking to a socket that keeps sending garbage. */
const MAX_INVALID_PAYLOADS = 40
/** Never send more than one rate-limit warning per socket per second. */
const RATE_WARNING_INTERVAL_MS = 1000

function connectionMeta(socket) {
  return {
    socketId: socket.id,
    transport: socket.conn?.transport?.name ?? 'unknown',
    // Origin is the only header we surface; the rest of the handshake (cookies,
    // auth headers, query strings) is deliberately never logged.
    origin: socket.handshake?.headers?.origin ?? null,
    clientIp: socket.handshake?.address ?? null,
  }
}

/**
 * @param {import('socket.io').Server} io
 * @param {{ logger: object, config?: object, registry?: object, roomId?: string }} deps
 */
export function registerSocketHandlers(io, { logger, config, registry = createPlayerRegistry(), roomId = DEFAULT_ROOM_ID } = {}) {
  const log = logger.child('socket')
  const room = Object.freeze({ id: roomId, maxPlayers: LIMITS.MAX_PLAYERS_PER_ROOM })

  const stats = {
    joins: 0,
    renames: 0,
    leaves: 0,
    acceptedMoves: 0,
    rejectedMoves: 0,
    droppedByRateLimit: 0,
    invalidPayloads: 0,
  }

  io.on('connection', (socket) => {
    const meta = connectionMeta(socket)
    log.info('socket connected', meta)

    // Per-socket state. Created here, once, so nothing can be registered twice.
    const session = {
      joined: false,
      bucket: createTokenBucket({ ratePerSecond: LIMITS.MOVE_UPDATES_PER_SECOND, burst: LIMITS.MOVE_BURST }),
      lastRateWarningAt: 0,
      invalidPayloads: 0,
    }

    const sendError = (code, message, data) => {
      socket.emit(EVENTS.ERROR, createError(code, message, data))
    }

    /** Tell the client where the server thinks it is (authoritative correction). */
    const sendCorrections = () => {
      const player = registry.get(socket.id)
      if (player) sendError(ERROR_CODES.INVALID_POSITION, 'position rejected', { x: player.x, y: player.y })
    }

    socket.conn?.on(TRANSPORT_UPGRADE, (transport) => {
      log.debug('transport upgraded', { socketId: socket.id, transport: transport?.name ?? 'unknown' })
    })

    socket.on('error', (error) => {
      log.warn('socket error', { socketId: socket.id, reason: error?.message })
    })

    // ------------------------------------------------------------- join -----

    socket.on(EVENTS.JOIN, (payload = {}) => {
      // Identity and room membership are server-owned: whatever a client puts in
      // these fields is ignored, not honoured.
      if (payload && typeof payload === 'object' && ('id' in payload || 'room' in payload || 'roomId' in payload)) {
        log.debug('ignored client-supplied identity/room', { socketId: socket.id })
      }

      const name = normaliseName(payload?.name)
      if (!name.ok) {
        stats.invalidPayloads += 1
        sendError(ERROR_CODES.INVALID_NAME, `Display name ${name.reason}`, {
          maxLength: LIMITS.NAME_MAX_LENGTH,
        })
        return
      }

      // Already registered: this is a rename (or a no-op), never a second player.
      if (session.joined) {
        const current = registry.get(socket.id)
        if (!current) {
          // Defensive: registry lost the entry (should not happen), re-register.
          session.joined = false
        } else if (current.name !== name.value) {
          const renamed = registry.rename(socket.id, name.value)
          stats.renames += 1
          log.info('player renamed', { socketId: socket.id, playerId: renamed.id })
          // Clients upsert by id, so one event covers both add and rename.
          socket.to(room.id).emit(EVENTS.JOINED, { player: renamed })
          socket.emit(EVENTS.JOINED, { player: renamed })
          return
        } else {
          return // identical name: nothing to do, nothing to broadcast
        }
      }

      if (registry.size >= room.maxPlayers) {
        sendError(ERROR_CODES.ROOM_FULL, 'This room is full — try again shortly.', { maxPlayers: room.maxPlayers })
        return
      }

      const registration = registry.add({ socketId: socket.id, name: name.value })
      if (!registration.ok) {
        sendError(ERROR_CODES.INTERNAL, 'Could not register this session.')
        return
      }

      session.joined = true
      stats.joins += 1
      socket.join(room.id)

      const others = registry.list().filter((player) => player.id !== registration.player.id)
      socket.emit(
        EVENTS.SNAPSHOT,
        createSnapshot({ self: registration.player, players: others, room }),
      )
      // Everyone already in the room learns about the newcomer.
      socket.to(room.id).emit(EVENTS.JOINED, { player: registration.player })

      log.info('player joined', {
        socketId: socket.id,
        playerId: registration.player.id,
        players: registry.size,
      })
    })

    // ------------------------------------------------------------- move -----

    socket.on(EVENTS.MOVE, (payload) => {
      if (!session.joined) {
        sendError(ERROR_CODES.JOIN_REQUIRED, 'Send player:join before moving.')
        return
      }

      if (!session.bucket.take()) {
        stats.droppedByRateLimit += 1
        const at = Date.now()
        if (at - session.lastRateWarningAt >= RATE_WARNING_INTERVAL_MS) {
          session.lastRateWarningAt = at
          sendError(ERROR_CODES.RATE_LIMITED, 'Movement updates are limited to 15 per second.', {
            hz: LIMITS.MOVE_UPDATES_PER_SECOND,
          })
        }
        return
      }

      const result = validateMove(payload, registry.lastPosition(socket.id))
      if (!result.ok) {
        stats.rejectedMoves += 1
        session.invalidPayloads += 1
        log.debug('rejected move', { socketId: socket.id, code: result.code, reason: result.reason })

        // Resync the client to the authoritative position for the rejected frame.
        if (result.code === ERROR_CODES.INVALID_POSITION) sendCorrections()
        else sendError(result.code, result.reason)

        if (session.invalidPayloads >= MAX_INVALID_PAYLOADS) {
          log.warn('disconnecting socket after repeated invalid payloads', {
            socketId: socket.id,
            invalidPayloads: session.invalidPayloads,
          })
          socket.disconnect(true)
        }
        return
      }

      const player = registry.move(socket.id, result.value)
      if (!player) {
        sendError(ERROR_CODES.JOIN_REQUIRED, 'Session is no longer registered.')
        return
      }
      stats.acceptedMoves += 1

      // Only the sender's own position changed, so only the room needs the delta.
      socket.to(room.id).emit(
        EVENTS.MOVED,
        createMoveUpdate({
          id: player.id,
          x: player.x,
          y: player.y,
          dir: player.dir,
          moving: player.moving,
        }),
      )
    })

    // --------------------------------------------------------- disconnect ---

    // Exactly one disconnect handler per socket; it removes all transient state
    // (registry entry, per-socket bucket) and notifies the room.
    socket.on('disconnect', (reason) => {
      const removed = registry.remove(socket.id)
      if (removed) {
        stats.leaves += 1
        socket.to(room.id).emit(EVENTS.LEFT, { id: removed.id })
        log.info('player left', { socketId: socket.id, playerId: removed.id, players: registry.size, reason })
      } else {
        log.info('socket disconnected', { socketId: socket.id, reason })
      }
    })
  })

  if (config?.corsOrigins?.includes('*')) {
    log.warn('CORS_ORIGIN is set to "*" — every origin may connect. Use exact origins outside local experiments.')
  }

  return { registry, room, stats }
}
