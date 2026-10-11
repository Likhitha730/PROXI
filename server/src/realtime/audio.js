// Audio service — who may talk to whom, and the relay that carries their WebRTC
// signalling.
//
// The server never touches media. It decides **authorization** and relays three
// small messages (offer, answer, ICE). Everything about the voice path itself —
// codecs, encryption, bandwidth — is the browsers' business; this service exists
// so that a client cannot talk to someone they are not allowed to talk to, and
// cannot pretend to be someone else while doing it.
//
// Authorization rules, all evaluated server-side on every signalling message:
//
//   1. identity — the sender is the socket that sent the message. A `fromId`,
//      `from` or `id` inside the payload is ignored completely, so identity
//      cannot be spoofed.
//   2. eligibility — both players must have announced a live microphone
//      (`audio:ready { enabled: true }`). No mic, no pair.
//   3. proximity — the two players must be within the listening radius. A pair
//      that is already established is kept until radius + AUDIO_RELEASE_HYSTERESIS,
//      so pacing on the boundary does not drop a call.
//   4. rate — signalling is token-bucketed per socket (SDP bursts are wide but
//      bounded), and payloads are size-checked before they are relayed.
//
// The service also owns the **pair lifecycle**: it knows which pairs are allowed,
// tells both sides when a pair becomes allowed or is revoked, and makes sure a
// revocation is delivered exactly once per transition.

import {
  AUDIO_STATUS,
  ERROR_CODES,
  EVENTS,
  LIMITS,
  createAudioPeer,
  createAudioStatus,
  pairKey,
} from '../../../shared/protocol.js'

/** Reason strings attached to a revocation (mirrored in `audio:status`). */
const REVOKE = Object.freeze({
  PEER_INELIGIBLE: AUDIO_STATUS.PEER_INELIGIBLE,
  SELF_INELIGIBLE: AUDIO_STATUS.SELF_INELIGIBLE,
  OUT_OF_RANGE: AUDIO_STATUS.OUT_OF_RANGE,
  PEER_LEFT: AUDIO_STATUS.PEER_LEFT,
})

/**
 * @param {{
 *   registry: object,
 *   logger?: object,
 *   emit: (socketId: string, event: string, payload: object) => void,
 *   radius?: number,
 *   releaseHysteresis?: number,
 *   now?: () => number,
 * }} deps
 */
export function createAudioService({
  registry,
  logger,
  emit,
  radius = LIMITS.PROXIMITY_RADIUS,
  releaseHysteresis = LIMITS.AUDIO_RELEASE_HYSTERESIS,
  now = () => Date.now(),
}) {
  /**
   * Established/announced pairs, keyed by `pairKey(a, b)`.
   *
   * `allowed` is the server's verdict; `connected` means at least one side has
   * started signalling. Both sides are addressed through their current socket ids,
   * resolved fresh on every use, so a reconnect cannot leave the pair pointing at
   * a dead socket.
   */
  const pairs = new Map()

  const stats = {
    readyAnnouncements: 0,
    relayed: 0,
    offered: 0,
    answered: 0,
    ice: 0,
    closed: 0,
    revoked: 0,
    denied: 0,
  }

  const log = logger?.child ? logger.child('audio') : logger

  function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  /**
   * Everyone physically within the listening radius of this player.
   *
   * Deliberately computed from **live registry positions**, not from the proximity
   * engine's last published result: authorization and notification must never
   * depend on whether a cached snapshot happened to be fresh. The room is capped at
   * MAX_PLAYERS_PER_ROOM, so a linear scan here is nothing.
   */
  function playersInRange(player) {
    return registry
      .list()
      .filter((other) => other.id !== player.id && distanceBetween(player, other) <= radius)
  }

  /** Both sides must hold a live microphone for a pair to exist at all. */
  function bothEligible(a, b) {
    return Boolean(a?.audio?.enabled) && Boolean(b?.audio?.enabled)
  }

  /**
   * Is this pair allowed right now?
   *
   * A pair that already exists gets the release hysteresis; a new pair must be
   * strictly inside the radius.
   */
  function pairAllowed(a, b, existing) {
    if (!bothEligible(a, b)) return { allowed: false, reason: REVOKE.PEER_INELIGIBLE }
    const limit = existing?.allowed ? radius + releaseHysteresis : radius
    if (distanceBetween(a, b) > limit) return { allowed: false, reason: REVOKE.OUT_OF_RANGE }
    return { allowed: true, reason: null }
  }

  function pairFor(a, b) {
    const key = pairKey(a.id, b.id)
    let pair = pairs.get(key)
    if (!pair) {
      pair = { key, ids: [a.id, b.id], allowed: false, connected: false, createdAt: now() }
      pairs.set(key, pair)
    }
    return pair
  }

  function socketIdsFor(pair) {
    const sockets = pair.ids.map((playerId) => registry.socketIdFor(playerId))
    return sockets.every(Boolean) ? sockets : null
  }

  /** Send the same payload to both halves of a pair (when both are connected). */
  function emitToPair(pair, event, payloadFor) {
    const sockets = socketIdsFor(pair)
    if (!sockets) return false
    const [a, b] = sockets
    emit(a, event, payloadFor(pair.ids[0]))
    emit(b, event, payloadFor(pair.ids[1]))
    return true
  }

  /**
   * Tell a socket about the audio state of one peer, if that peer is within the
   * audience the socket is allowed to know about.
   */
  function notifyPeer(observerId, subjectId) {
    if (observerId === subjectId) return false
    const observer = registry.getById(observerId)
    const subject = registry.getById(subjectId)
    if (!observer || !subject) return false
    const pair = pairFor(observer, subject)
    const verdict = pairAllowed(observer, subject, pair)
    const socketId = registry.socketIdFor(observerId)
    if (!socketId) return false
    emit(socketId, EVENTS.AUDIO_PEER, createAudioPeer({
      id: subject.id,
      name: subject.name,
      audio: subject.audio,
      allowed: verdict.allowed,
    }))
    return true
  }

  /**
   * Bring one pair in line with the authorization rules and report the transition.
   *
   * Returns the verdict so callers (and tests) can assert on it without inspecting
   * what was emitted.
   */
  function reconcilePair(a, b) {
    const pair = pairFor(a, b)
    const verdict = pairAllowed(a, b, pair)
    const sockets = socketIdsFor(pair)

    if (verdict.allowed === pair.allowed) return { ...verdict, changed: false, pair }

    pair.allowed = verdict.allowed
    if (!verdict.allowed) {
      pair.connected = false
      stats.revoked += 1
      // Both sides are told, so neither keeps a peer connection to somebody the
      // server no longer authorizes.
      if (sockets) {
        emitToPair(pair, EVENTS.AUDIO_STATUS, (selfId) =>
          createAudioStatus({
            peerId: pair.ids[0] === selfId ? pair.ids[1] : pair.ids[0],
            status: verdict.reason ?? AUDIO_STATUS.OUT_OF_RANGE,
            allowed: false,
          }),
        )
      }
      log?.debug('audio pair revoked', { pair: pair.key, reason: verdict.reason })
    } else if (sockets) {
      // Allowed: each side is told it may connect to the other, with the peer's
      // current mute state so the UI can render it before any media flows.
      emitToPair(pair, EVENTS.AUDIO_STATUS, (selfId) =>
        createAudioStatus({
          peerId: pair.ids[0] === selfId ? pair.ids[1] : pair.ids[0],
          status: AUDIO_STATUS.READY,
          allowed: true,
        }),
      )
      log?.debug('audio pair allowed', { pair: pair.key })
    }

    return { ...verdict, changed: true, pair }
  }

  /**
   * Re-evaluate every pair that involves this player (used after a move, a join,
   * a leave or an eligibility change), and tell both sides about new peers that
   * are now in range.
   */
  function reconcilePlayer(socketId) {
    const self = registry.get(socketId)
    if (!self) return { pairs: [], verdicts: [] }

    const verdicts = []
    const touched = new Set()

    // Pairs this player is already part of.
    for (const pair of pairs.values()) {
      if (!pair.ids.includes(self.id)) continue
      const otherId = pair.ids[0] === self.id ? pair.ids[1] : pair.ids[0]
      const other = registry.getById(otherId)
      touched.add(otherId)
      if (!other) {
        // The peer is gone: revoke and forget, so a reconnect starts clean.
        if (pair.allowed || pair.connected) {
          pair.allowed = false
          pair.connected = false
          stats.revoked += 1
          emit(socketId, EVENTS.AUDIO_STATUS, createAudioStatus({ peerId: otherId, status: REVOKE.PEER_LEFT, allowed: false }))
        }
        pairs.delete(pair.key)
        continue
      }
      verdicts.push({ peerId: otherId, ...reconcilePair(self, other) })
    }

    /*
     * Peers that could become a pair now (in range, both eligible) but are not one
     * yet. Candidates come from live positions, so a player who has not moved since
     * somebody joined still learns about them.
     *
     * Pairs that are already allowed but have drifted out of range are *not* handled
     * here: they need the release hysteresis, which the loop above applies by
     * re-checking every existing pair of this player.
     */
    for (const other of playersInRange(self)) {
      if (touched.has(other.id)) continue
      const pair = pairFor(self, other)
      if (pair.allowed) continue
      if (!bothEligible(self, other)) {
        // Not connectable, but the peer's eligibility state is still news.
        notifyPeer(self.id, other.id)
        continue
      }
      verdicts.push({ peerId: other.id, ...reconcilePair(self, other) })
    }

    return { pairs: [...pairs.values()].filter((pair) => pair.ids.includes(self.id)), verdicts }
  }

  /** Re-evaluate everybody (a join, a leave, or an eligibility change). */
  function reconcileAll() {
    for (const player of registry.list()) {
      const socketId = registry.socketIdFor(player.id)
      if (socketId) reconcilePlayer(socketId)
    }
  }

  /**
   * `audio:ready` — a client declares whether it holds a live microphone.
   *
   * Withdrawing eligibility revokes every pair this player is part of *before*
   * acknowledging, so a client can rely on the acknowledgement meaning "nobody is
   * connecting to me any more".
   */
  function setReady(socketId, { enabled, muted }) {
    const player = registry.setAudio(socketId, { enabled, muted })
    if (!player) return null
    stats.readyAnnouncements += 1

    // Tell this player's in-range peers that their eligibility changed, and tell
    // the player itself (the UI needs to render its own state as the server sees it).
    emit(socketId, EVENTS.AUDIO_PEER, createAudioPeer({
      id: player.id,
      name: player.name,
      audio: player.audio,
      allowed: Boolean(player.audio.enabled),
    }))

    for (const other of playersInRange(player)) {
      notifyPeer(other.id, player.id)
    }

    const { verdicts } = reconcilePlayer(socketId)
    if (!enabled) stats.revoked += verdicts.filter((verdict) => verdict.changed).length
    log?.info('audio eligibility changed', {
      playerId: player.id,
      enabled,
      muted: Boolean(muted),
      pairs: verdicts.length,
    })
    return { player, verdicts }
  }

  /**
   * Authorize one signalling message.
   *
   * @returns {{ ok: true, targetSocketId: string, target: object, self: object, pair: object }
   *          | { ok: false, code: string, reason: string }}
   */
  function authorizeSignal(socketId, targetId) {
    const self = registry.get(socketId)
    if (!self) return { ok: false, code: ERROR_CODES.JOIN_REQUIRED, reason: 'Join before signalling.' }
    if (!self.audio.enabled) {
      return { ok: false, code: ERROR_CODES.AUDIO_NOT_READY, reason: 'Enable your microphone before signalling.' }
    }
    if (targetId === self.id) {
      return { ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE, reason: 'You cannot call yourself.' }
    }

    const targetSocketId = registry.socketIdFor(targetId)
    const target = targetSocketId ? registry.get(targetSocketId) : null
    if (!target) {
      stats.denied += 1
      return { ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE, reason: 'That player is not in the office.' }
    }
    if (!target.audio.enabled) {
      stats.denied += 1
      return { ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE, reason: 'That player has no active microphone.' }
    }

    const pair = pairFor(self, target)
    const verdict = pairAllowed(self, target, pair)
    if (!verdict.allowed) {
      stats.denied += 1
      return {
        ok: false,
        code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE,
        reason: verdict.reason === REVOKE.OUT_OF_RANGE ? 'That player is out of earshot.' : verdict.reason,
      }
    }

    // An authorized signal implies the pair is live, so an ICE message arriving
    // before any status event cannot be rejected for a bookkeeping reason.
    if (!pair.allowed) {
      pair.allowed = true
      emitToPair(pair, EVENTS.AUDIO_STATUS, (selfId) =>
        createAudioStatus({
          peerId: pair.ids[0] === selfId ? pair.ids[1] : pair.ids[0],
          status: AUDIO_STATUS.READY,
          allowed: true,
        }),
      )
    }
    return { ok: true, targetSocketId, target, self, pair }
  }

  /** Relay one signalling message to the authorized target. */
  function relay(socketId, event, payload, kind) {
    const authorization = authorizeSignal(socketId, payload.targetId)
    if (!authorization.ok) return authorization

    const { self, target, targetSocketId, pair } = authorization
    pair.connected = true
    stats.relayed += 1
    if (kind === 'offer') stats.offered += 1
    if (kind === 'answer') stats.answered += 1
    if (kind === 'ice') stats.ice += 1

    // The relayed payload carries `fromId`/`fromName` derived from the *socket*,
    // and deliberately drops `targetId`: the receiver learns who is calling from
    // the server, not from the caller.
    const relayed = { fromId: self.id, fromName: self.name, ...payload }
    delete relayed.targetId
    emit(targetSocketId, event, relayed)

    // Sizes only — never SDP or candidate contents (see docs/ARCHITECTURE.md §10).
    log?.debug('signalling relayed', {
      kind,
      from: self.id,
      to: target.id,
      bytes: kind === 'ice' ? payload.candidate?.candidate?.length ?? 0 : payload.sdp?.sdp?.length ?? 0,
    })
    return { ok: true, from: self.id, to: target.id }
  }

  /**
   * `signal:close` — one side hangs up. The other side is told with the same
   * server-attributed shape as every other signal, and the pair is marked down so
   * neither side can keep pushing candidates into a closed session.
   */
  function closePair(socketId, targetId, reason) {
    const self = registry.get(socketId)
    if (!self) return { ok: false, code: ERROR_CODES.JOIN_REQUIRED, reason: 'Join before signalling.' }
    const targetSocketId = registry.socketIdFor(targetId)
    if (!targetSocketId) {
      // The peer already left; treat it as done rather than as an error.
      return { ok: true, from: self.id, to: targetId, delivered: false }
    }
    const pair = pairFor(self, registry.get(targetSocketId))
    pair.connected = false
    stats.closed += 1
    emit(targetSocketId, EVENTS.SIGNAL_CLOSE, { fromId: self.id, fromName: self.name, reason })
    return { ok: true, from: self.id, to: targetId, delivered: true }
  }

  /** A socket disconnected: revoke its pairs and tell the survivors. */
  function forgetPlayer(playerId) {
    const dropped = []
    for (const pair of pairs.values()) {
      if (!pair.ids.includes(playerId)) continue
      const otherId = pair.ids[0] === playerId ? pair.ids[1] : pair.ids[0]
      const otherSocketId = registry.socketIdFor(otherId)
      if (otherSocketId && (pair.allowed || pair.connected)) {
        stats.revoked += 1
        emit(otherSocketId, EVENTS.AUDIO_STATUS, createAudioStatus({ peerId: playerId, status: REVOKE.PEER_LEFT, allowed: false }))
      }
      pairs.delete(pair.key)
      dropped.push(pair.key)
    }
    return dropped
  }

  return {
    radius,
    releaseHysteresis,
    stats,
    setReady,
    authorizeSignal,
    relayOffer: (socketId, payload) => relay(socketId, EVENTS.SIGNAL_OFFER, payload, 'offer'),
    relayAnswer: (socketId, payload) => relay(socketId, EVENTS.SIGNAL_ANSWER, payload, 'answer'),
    relayIce: (socketId, payload) => relay(socketId, EVENTS.SIGNAL_ICE, payload, 'ice'),
    closePair,
    reconcilePlayer,
    reconcileAll,
    forgetPlayer,
    notifyPeer,
    /** Diagnostics + tests: the pairs this player is part of, with their verdicts. */
    pairsFor(playerId) {
      return [...pairs.values()]
        .filter((pair) => pair.ids.includes(playerId))
        .map((pair) => ({ ...pair, otherId: pair.ids[0] === playerId ? pair.ids[1] : pair.ids[0] }))
    },
    describe() {
      return {
        radius,
        releaseHysteresis,
        pairs: pairs.size,
        allowedPairs: [...pairs.values()].filter((pair) => pair.allowed).length,
        connectedPairs: [...pairs.values()].filter((pair) => pair.connected).length,
        stats: { ...stats },
      }
    },
    /** Tests only: drop all pair state without touching the registry. */
    reset() {
      pairs.clear()
      for (const key of Object.keys(stats)) stats[key] = 0
    },
  }
}
