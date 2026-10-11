// Presence model — who else is in the office, where they are, and how they move.
//
// This module is the bridge between the socket (which delivers ~15 Hz deltas) and
// two very different consumers:
//
//   1. the canvas engine, which needs a smooth position for every remote avatar
//      on *every animation frame*. `collectPeers(now)` returns live, reused
//      objects interpolated from the motion buffer — no React, no allocation on
//      the hot path.
//   2. the React HUD, which must NOT re-render per movement event. It gets a
//      frozen snapshot that only changes when something structural happens:
//      a player joins, leaves, renames, or the session state changes.
//
// Movement therefore never touches React state. That is the whole reason the two
// views are separated here.

import { createAvatarAppearance } from '../render/avatarAppearance.js'
import { createMotionBuffer } from '../render/interpolation.js'
import { hashString } from '../world/random.js'

const INITIAL_SNAPSHOT = Object.freeze({
  ready: false,
  self: null,
  room: null,
  players: Object.freeze([]),
  count: 0,
  lastError: null,
  corrections: 0,
  acceptedMoves: 0,
})

/**
 * @param {{ now?: () => number, onChange?: (snapshot: object) => void }} [options]
 */
export function createPresence({ now = () => performance.now() } = {}) {
  /** @type {Map<string, object>} remote players, keyed by server player id */
  const peers = new Map()
  const listeners = new Set()

  let snapshot = INITIAL_SNAPSHOT
  let self = null
  let room = null
  let corrections = 0
  let acceptedMoves = 0
  /** Pending authoritative position from the server, drained by the engine. */
  let pendingCorrection = null

  /** Reused array so `collectPeers` does not allocate every frame. */
  const peerList = []

  function rebuildSnapshot(patch = {}) {
    const players = [...peers.values()].map((peer) => Object.freeze({ id: peer.id, name: peer.name }))
    snapshot = Object.freeze({
      ...INITIAL_SNAPSHOT,
      ready: Boolean(self),
      self,
      room,
      players: Object.freeze(players),
      count: players.length + (self ? 1 : 0),
      corrections,
      acceptedMoves,
      ...patch,
    })
    for (const listener of listeners) listener()
  }

  function toPeerState(record) {
    const existing = peers.get(record.id)
    if (existing) {
      // Keep identity-derived fields (appearance, blink seed) and the buffer.
      existing.name = record.name ?? existing.name
      existing.x = record.x
      existing.y = record.y
      existing.dir = record.dir ?? existing.dir
      existing.moving = Boolean(record.moving)
      if (record.nearby !== undefined) existing.nearby = Boolean(record.nearby)
      if (record.speaking !== undefined) existing.speaking = Boolean(record.speaking)
      if (record.muted !== undefined) existing.muted = Boolean(record.muted)
      if (record.distance !== undefined) existing.distance = record.distance
      return existing
    }

    const peer = {
      id: record.id,
      name: record.name ?? 'Guest',
      // Varied, deterministic look per player id; created once per session.
      appearance: createAvatarAppearance(record.id),
      blinkSeed: hashString(String(record.id)),
      isLocal: false,
      x: record.x,
      y: record.y,
      facing: record.dir ?? Math.PI / 2,
      moving: Boolean(record.moving),
      walkPhase: 0,
      speaking: Boolean(record.speaking),
      muted: Boolean(record.muted),
      nearby: Boolean(record.nearby),
      distance: record.distance,
      motion: createMotionBuffer(),
      lastFrameX: record.x,
      lastFrameY: record.y,
    }
    peer.motion.push({ x: record.x, y: record.y, dir: peer.facing, moving: peer.moving, at: now() })
    peers.set(record.id, peer)
    return peer
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Coarse, frozen view for React. Changes on membership/session events only. */
    getSnapshot() {
      return snapshot
    },

    get self() {
      return self
    },

    get peerCount() {
      return peers.size
    },

    /**
     * Movement samples accepted this session. Read by telemetry/tests — kept off
     * the React snapshot on purpose, because movement must not re-render the tree.
     */
    get moveCount() {
      return acceptedMoves
    },

    has(id) {
      return peers.has(id)
    },

    /** `players:snapshot` — the roster we get on joining (self + everyone else). */
    applySnapshot(payload) {
      peers.clear()
      self = payload?.self ? Object.freeze({ ...payload.self }) : null
      room = payload?.room ? Object.freeze({ ...payload.room }) : null
      for (const record of payload?.players ?? []) toPeerState(record)
      rebuildSnapshot({ lastError: null })
      return snapshot
    },

    /** `player:joined` — an upsert, so it also covers renames. */
    applyJoined(payload) {
      const record = payload?.player
      if (!record?.id) return snapshot
      if (self && record.id === self.id) {
        self = Object.freeze({ ...self, ...record })
        rebuildSnapshot()
        return snapshot
      }
      toPeerState(record)
      rebuildSnapshot()
      return snapshot
    },

    /** `player:moved` — 15 Hz hot path: buffer it, do not touch React. */
    applyMove(update) {
      const peer = peers.get(update?.id)
      if (!peer) return false // a delta for someone we do not know yet
      acceptedMoves += 1
      return peer.motion.push({
        x: update.x,
        y: update.y,
        dir: update.dir ?? peer.facing,
        moving: update.moving,
        at: now(),
      })
    },

    /** `player:left` — transient state goes away with them. */
    applyLeft(payload) {
      const id = payload?.id
      if (!id || !peers.delete(id)) return snapshot
      rebuildSnapshot()
      return snapshot
    },

    /**
     * `server:error`. A rejected position comes with the authoritative
     * coordinates, which the engine drains through `takeCorrection()`.
     */
    applyError(payload) {
      if (payload?.code === 'invalid_position' && payload.data) {
        corrections += 1
        pendingCorrection = { x: payload.data.x, y: payload.data.y }
        rebuildSnapshot({ lastError: null })
        return snapshot
      }
      rebuildSnapshot({ lastError: payload ? { code: payload.code, message: payload.message } : null })
      return snapshot
    },

    /** Clear a displayed error (used by the HUD dismiss button). */
    clearError() {
      if (!snapshot.lastError) return snapshot
      rebuildSnapshot({ lastError: null })
      return snapshot
    },

    /** The engine calls this every frame; an empty array means "nobody else". */
    collectPeers(nowMs = now()) {
      peerList.length = 0
      for (const peer of peers.values()) {
        const state = peer.motion.sample(nowMs)
        if (state) {
          peer.x = state.x
          peer.y = state.y
          peer.facing = state.dir
          peer.moving = state.moving
          peer.stale = state.stale
        }
        peerList.push(peer)
      }
      return peerList
    },

    takeCorrection() {
      const correction = pendingCorrection
      pendingCorrection = null
      return correction
    },

    reset() {
      peers.clear()
      peerList.length = 0
      self = null
      room = null
      corrections = 0
      acceptedMoves = 0
      pendingCorrection = null
      snapshot = INITIAL_SNAPSHOT
      for (const listener of listeners) listener()
    },

    /** Test/debug helper: raw peer state without interpolation. */
    getPeers() {
      return [...peers.values()]
    },
  }
}

/** The single presence instance the app uses (mirrors the socket singleton). */
export const presence = createPresence()
