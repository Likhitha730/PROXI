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
  validateAnswer,
  validateAudioReady,
  validateIce,
  validateMove,
  validateOffer,
  validateSignalClose,
} from '../../../shared/protocol.js'
import { createPlayerRegistry } from '../realtime/registry.js'
import { createTokenBucket } from '../realtime/rateLimiter.js'
import { createProximityEngine } from '../realtime/proximity.js'
import { createAudioService } from '../realtime/audio.js'

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
export function registerSocketHandlers(
  io,
  {
    logger,
    config,
    registry = createPlayerRegistry(),
    positions = null,
    roomId = DEFAULT_ROOM_ID,
    now = () => Date.now(),
  } = {},
) {
  const log = logger.child('socket')
  const room = Object.freeze({ id: roomId, maxPlayers: LIMITS.MAX_PLAYERS_PER_ROOM })
  const radius = config?.proximityRadius ?? LIMITS.PROXIMITY_RADIUS

  const stats = {
    joins: 0,
    renames: 0,
    leaves: 0,
    acceptedMoves: 0,
    rejectedMoves: 0,
    droppedByRateLimit: 0,
    invalidPayloads: 0,
    proximityUpdates: 0,
    persistedWrites: 0,
    persistFailures: 0,
    audioReady: 0,
    signalsRelayed: 0,
    signalsDenied: 0,
  }

  // Proximity is computed from the registry (live connections only), never from
  // MongoDB: a disconnected session must vanish from "nearby" immediately, and a
  // database round trip has no place in a 4 Hz loop.
  const proximity = createProximityEngine({
    registry,
    radius,
    now,
    onUpdate: (socketId, result) => {
      const target = io.sockets.sockets.get(socketId)
      if (!target) return
      target.emit(EVENTS.PROXIMITY, result)
      stats.proximityUpdates += 1
      // Whoever moved may have walked in or out of range of somebody: audio
      // authorization follows proximity, and neither side keeps a call the
      // server no longer authorizes.
      audio.reconcilePlayer(socketId)
    },
  })

  /**
   * Audio authorization + WebRTC signalling relay (see realtime/audio.js).
   *
   * `emit` addresses a socket id that the service resolved from the *registry*, so
   * a message can only ever be delivered to the connection that currently hosts
   * the target player — never to a socket a client named.
   */
  const audio = createAudioService({
    registry,
    logger,
    radius,
    emit: (socketId, event, payload) => {
      const target = io.sockets.sockets.get(socketId)
      if (target) target.emit(event, payload)
    },
  })

  io.on('connection', (socket) => {
    const meta = connectionMeta(socket)
    log.info('socket connected', meta)

    // Per-socket state. Created here, once, so nothing can be registered twice.
    const session = {
      joined: false,
      bucket: createTokenBucket({ ratePerSecond: LIMITS.MOVE_UPDATES_PER_SECOND, burst: LIMITS.MOVE_BURST }),
      // Signalling (SDP + ICE) is bursty by nature, so it gets its own, wider bucket.
      signalBucket: createTokenBucket({
        ratePerSecond: LIMITS.AUDIO_SIGNALING_PER_SECOND,
        burst: LIMITS.AUDIO_SIGNALING_BURST,
      }),
      lastRateWarningAt: 0,
      invalidPayloads: 0,
    }

    const sendError = (code, message, data) => {
      socket.emit(EVENTS.ERROR, createError(code, message, data))
    }

    let lastPersistAt = 0

    /**
     * Persist the player's position. Fire-and-forget by design: the realtime path
     * must not wait for (or fail because of) the database, and the repository
     * already converts failures into logged warnings.
     */
    const persist = (player, { force = false } = {}) => {
      if (!positions || !player) return
      const at = now()
      if (!force && at - lastPersistAt < (config?.positionFlushMs ?? 2000)) return
      lastPersistAt = at
      positions
        .savePosition({
          sessionId: player.id,
          name: player.name,
          x: player.x,
          y: player.y,
          connected: true,
        })
        .then((result) => {
          if (result?.ok === false) stats.persistFailures += 1
          else stats.persistedWrites += 1
        })
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

      // Persist the spawn position immediately so the archive has an entry from
      // the first moment of the session (no-op when the database is unavailable).
      lastPersistAt = now()
      persist(registration.player, { force: true })
      // Track before announcing, so this player is included in everyone's result.
      proximity.track(socket.id)

      const others = registry.list().filter((player) => player.id !== registration.player.id)
      socket.emit(
        EVENTS.SNAPSHOT,
        createSnapshot({ self: registration.player, players: others, room }),
      )
      // Everyone already in the room learns about the newcomer.
      socket.to(room.id).emit(EVENTS.JOINED, { player: registration.player })

      // Membership changed, so every proximity result is recomputed and published
      // at once — a join is never delayed by the movement throttle.
      proximity.updateAll()
      // A newcomer starts with audio disabled (it is in their player record, which
      // everyone just received); this teaches *them* who is already talking.
      audio.reconcilePlayer(socket.id)

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

      // Our position changed: recompute our own neighbourhood, and also the players
      // whose range we may have just entered or left — otherwise somebody standing
      // still would never notice that a colleague walked up to them.
      proximity.updateAffected(socket.id)
      persist(player)
    })

    // ------------------------------------------------------------- audio ---

    /**
     * `audio:ready` — the client declares whether it holds a live microphone.
     *
     * The server records the declaration on the player record and re-evaluates
     * every pair this player is part of, so enabling the microphone immediately
     * authorizes the people already in earshot.
     */
    socket.on(EVENTS.AUDIO_READY, (payload) => {
      if (!session.joined) {
        sendError(ERROR_CODES.JOIN_REQUIRED, 'Send player:join before announcing audio.')
        return
      }
      const result = validateAudioReady(payload)
      if (!result.ok) {
        stats.invalidPayloads += 1
        sendError(result.code, `audio:ready rejected: ${result.reason}`)
        return
      }
      stats.audioReady += 1
      audio.setReady(socket.id, result.value)
    })

    /**
     * Signalling relay.
     *
     * Identity comes from the socket, the target is checked against the registry,
     * both sides must be eligible and in earshot, and the payload must be a bounded
     * session description or ICE candidate. Only then is anything forwarded.
     */
    const relaySignal = (event, validate, forward, kind) => {
      socket.on(event, (payload) => {
        if (!session.joined) {
          sendError(ERROR_CODES.JOIN_REQUIRED, 'Send player:join before signalling.')
          return
        }
        // Checked before parsing, like movement: a flood costs the server nothing.
        if (!session.signalBucket.take(now())) {
          stats.droppedByRateLimit += 1
          sendError(ERROR_CODES.RATE_LIMITED, 'Too many signalling messages — slow down.')
          return
        }
        const result = validate(payload)
        if (!result.ok) {
          stats.invalidPayloads += 1
          sendError(result.code, `${kind} rejected: ${result.reason}`)
          return
        }
        const relayed = forward(socket.id, result.value)
        if (relayed.ok) {
          stats.signalsRelayed += 1
        } else {
          stats.signalsDenied += 1
          sendError(relayed.code, relayed.reason)
        }
      })
    }

    relaySignal(EVENTS.SIGNAL_OFFER, validateOffer, (socketId, value) => audio.relayOffer(socketId, value), 'offer')
    relaySignal(EVENTS.SIGNAL_ANSWER, validateAnswer, (socketId, value) => audio.relayAnswer(socketId, value), 'answer')
    relaySignal(EVENTS.SIGNAL_ICE, validateIce, (socketId, value) => audio.relayIce(socketId, value), 'ice')

    /**
     * `signal:close` — an intentional hang-up. It is authorized like any other
     * signal (you may only close a pair you are allowed to have), but a peer who
     * already disconnected is not an error: the call is over either way.
     */
    socket.on(EVENTS.SIGNAL_CLOSE, (payload) => {
      if (!session.joined) {
        sendError(ERROR_CODES.JOIN_REQUIRED, 'Send player:join before signalling.')
        return
      }
      if (!session.signalBucket.take(now())) {
        stats.droppedByRateLimit += 1
        sendError(ERROR_CODES.RATE_LIMITED, 'Too many signalling messages — slow down.')
        return
      }
      const result = validateSignalClose(payload)
      if (!result.ok) {
        stats.invalidPayloads += 1
        sendError(result.code, `signal:close rejected: ${result.reason}`)
        return
      }
      audio.closePair(socket.id, result.value.targetId, result.value.reason)
    })

    // --------------------------------------------------------- disconnect ---

    // Exactly one disconnect handler per socket; it removes all transient state
    // (registry entry, per-socket bucket) and notifies the room.
    socket.on('disconnect', (reason) => {
      proximity.forget(socket.id)
      // Audio pairs are revoked by player id *before* the registry forgets them, so
      // the survivors are told the call ended and nobody keeps a dead peer connection.
      const removed = registry.remove(socket.id)
      if (removed) {
        // Revoke by player id after the registry no longer holds the socket: the
        // survivors are told their call ended, so nobody keeps a dead peer connection.
        audio.forgetPlayer(removed.id)
        stats.leaves += 1
        // The archive keeps the (now flagged) record; live presence does not.
        positions?.markDisconnected(removed.id)?.then?.((result) => {
          if (result?.ok === false) stats.persistFailures += 1
        })
        socket.to(room.id).emit(EVENTS.LEFT, { id: removed.id })
        // Everyone left behind gets a fresh neighbourhood without the leaver.
        proximity.updateAll()
        log.info('player left', { socketId: socket.id, playerId: removed.id, players: registry.size, reason })
      } else {
        log.info('socket disconnected', { socketId: socket.id, reason })
      }
    })
  })

  if (config?.corsOrigins?.includes('*')) {
    log.warn('CORS_ORIGIN is set to "*" — every origin may connect. Use exact origins outside local experiments.')
  }

  return { registry, room, stats, proximity, radius, audio }
}
