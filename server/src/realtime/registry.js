// Server-side player registry — the authoritative presence table.
//
// One entry per connected Socket.IO socket, keyed by socket id and carrying a
// *server-generated* player id. Nothing here ever trusts a client-supplied
// identity: the id is minted with `crypto.randomUUID()` and the socket id is the
// only key a client can influence, indirectly, by connecting.
//
// The registry owns the last accepted position of every player, which is what
// makes the server authoritative: a rejected `player:move` never mutates state,
// and the stored position is what the client is resynced to.

import { randomUUID } from 'node:crypto'
import { createAudioState, createPlayerRecord, pickSpawnPoint } from '../../../shared/protocol.js'

export function createPlayerRegistry({ idFactory = randomUUID, now = Date.now } = {}) {
  /** @type {Map<string, { player: object, socketId: string, lastPosition: {x:number,y:number,at:number} }>} */
  const bySocketId = new Map()

  function toRecord(entry) {
    return entry.player
  }

  return {
    /** True when this socket already has a player (a second join is a rename, not a registration). */
    has(socketId) {
      return bySocketId.has(socketId)
    },

    get(socketId) {
      const entry = bySocketId.get(socketId)
      return entry ? toRecord(entry) : null
    },

    getById(playerId) {
      for (const entry of bySocketId.values()) {
        if (entry.player.id === playerId) return toRecord(entry)
      }
      return null
    },

    /**
     * The socket currently hosting a player id, or null.
     *
     * Player ids are what the protocol exposes; socket ids are what the server needs
     * to address one connection. Proximity uses this to tell *people* about a move.
     */
    socketIdFor(playerId) {
      for (const [socketId, entry] of bySocketId) {
        if (entry.player.id === playerId) return socketId
      }
      return null
    },

    /** Full player records, newest last. Used for snapshots and joins. */
    list() {
      return [...bySocketId.values()].map(toRecord)
    },

    get size() {
      return bySocketId.size
    },

    /**
     * Register a player for a socket.
     * Rejects a socket that is already registered — callers use `rename` for that,
     * so one socket can never produce two players.
     *
     * @returns {{ ok: true, player: object } | { ok: false, reason: 'already_registered' }}
     */
    add({ socketId, name, now: at = now() }) {
      if (bySocketId.has(socketId)) return { ok: false, reason: 'already_registered' }

      const spawn = pickSpawnPoint(this.list())
      const player = createPlayerRecord({
        id: idFactory(),
        name,
        x: spawn.x,
        y: spawn.y,
        dir: Math.PI / 2, // facing into the lobby
        moving: false,
        joinedAt: at,
      })

      bySocketId.set(socketId, { player, socketId, lastPosition: { x: spawn.x, y: spawn.y, at } })
      return { ok: true, player }
    },

    /**
     * Change the display name of a registered socket. Identity, position and
     * join time are preserved — only the label changes.
     */
    rename(socketId, name) {
      const entry = bySocketId.get(socketId)
      if (!entry) return null
      if (entry.player.name === name) return entry.player
      entry.player = Object.freeze({ ...entry.player, name })
      return entry.player
    },

    /** Where the server last accepted this player (anti-teleport baseline). */
    lastPosition(socketId) {
      return bySocketId.get(socketId)?.lastPosition ?? null
    },

    /**
     * Replace a socket's audio eligibility.
     *
     * Like `move`, this is the only way the audio block changes, so a client cannot
     * claim audio state for anyone but itself — the socket id decides whose record
     * is touched, never a value from the payload.
     *
     * @returns {object|null} the updated player record, or null when not registered
     */
    setAudio(socketId, audio) {
      const entry = bySocketId.get(socketId)
      if (!entry) return null
      const next = createAudioState({ ...entry.player.audio, ...audio })
      if (
        next.enabled === entry.player.audio.enabled &&
        next.muted === entry.player.audio.muted
      ) {
        return entry.player // no change: do not create a new object for nothing
      }
      entry.player = Object.freeze({ ...entry.player, audio: next })
      return entry.player
    },

    /**
     * Apply a validated position. This is the only way a position changes, so
     * invalid input cannot corrupt the authoritative state.
     */
    move(socketId, { x, y, dir, moving, at = now() }) {
      const entry = bySocketId.get(socketId)
      if (!entry) return null
      const next = { ...entry.player, x, y, moving }
      if (dir !== null && dir !== undefined) next.dir = dir
      entry.player = Object.freeze(next)
      entry.lastPosition = { x, y, at }
      return entry.player
    },

    /** Remove transient state for a socket. Returns the removed player, or null. */
    remove(socketId) {
      const entry = bySocketId.get(socketId)
      if (!entry) return null
      bySocketId.delete(socketId)
      return toRecord(entry)
    },

    clear() {
      bySocketId.clear()
    },
  }
}
