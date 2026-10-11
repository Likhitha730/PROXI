// Audio service tests — who is allowed to talk to whom.
//
// These are unit tests over the service with a real registry and real proximity
// engine, and a recording `emit`. The point of the suite is the *authorization
// boundary*: identity comes from the socket, both sides must hold a live
// microphone, and both must be in earshot.

import { beforeEach, describe, expect, it } from 'vitest'
import { createAudioService } from './audio.js'
import { createProximityEngine } from './proximity.js'
import { createPlayerRegistry } from './registry.js'
import { AUDIO_STATUS, ERROR_CODES, EVENTS, LIMITS } from '../../../shared/protocol.js'

let idCounter = 0
let registry
let proximity
let emitted
let audio

const emit = (socketId, event, payload) => emitted.push({ socketId, event, payload })

function setup({ radius = LIMITS.PROXIMITY_RADIUS } = {}) {
  idCounter = 0
  emitted = []
  registry = createPlayerRegistry({ idFactory: () => `player-${++idCounter}`, now: () => 1_000_000 })
  proximity = createProximityEngine({ registry, radius, onUpdate: () => {} })
  audio = createAudioService({ registry, proximity, emit, radius })
  return audio
}

/**
 * Register a player at a position and (optionally) announce a live microphone.
 * Returns the socket id, which is the only handle the service accepts.
 */
function place(socketId, name, x, y, { mic = false, muted = false } = {}) {
  registry.add({ socketId, name })
  registry.move(socketId, { x, y, moving: false })
  proximity.track(socketId)
  if (mic) audio.setReady(socketId, { enabled: true, muted })
  return registry.get(socketId)
}

const eventsFor = (socketId, event) => emitted.filter((entry) => entry.socketId === socketId && entry.event === event)
const lastFor = (socketId, event) => eventsFor(socketId, event).at(-1)?.payload ?? null

beforeEach(() => {
  setup()
})

describe('eligibility announcements', () => {
  it('echoes the server\u2019s view of your own audio state', () => {
    place('a', 'Ada', 1000, 1000, { mic: true, muted: true })
    const echo = lastFor('a', EVENTS.AUDIO_PEER)
    expect(echo).toMatchObject({ peerId: registry.get('a').id, name: 'Ada', enabled: true, muted: true })
    expect(audio.stats.readyAnnouncements).toBe(1)
  })

  it('tells in-range peers that somebody enabled their microphone', () => {
    const ada = place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 1040, 1000, { mic: true })

    const notice = lastFor('a', EVENTS.AUDIO_PEER)
    // Ada learns that Grace has a microphone... but the *pair* is not authorized,
    // because Ada has not enabled hers: visible, not connectable.
    expect(notice).toMatchObject({ peerId: registry.get('b').id, name: 'Grace', enabled: true, allowed: false })
    expect(notice.peerId).not.toBe(ada.id)

    // Once Ada enables hers too, Grace is told, and the pair is announced as ready
    // to both of them.
    emitted.length = 0
    audio.setReady('a', { enabled: true, muted: false })

    // Ada's own message is the server's echo of her state.
    expect(lastFor('a', EVENTS.AUDIO_PEER)).toMatchObject({ peerId: registry.get('a').id, enabled: true })
    // Grace hears about Ada's microphone...
    expect(lastFor('b', EVENTS.AUDIO_PEER)).toMatchObject({ peerId: registry.get('a').id, enabled: true, allowed: true })
    // ...and both sides learn the pair may now connect.
    expect(lastFor('a', EVENTS.AUDIO_STATUS)).toMatchObject({ peerId: registry.get('b').id, status: AUDIO_STATUS.READY, allowed: true })
    expect(lastFor('b', EVENTS.AUDIO_STATUS)).toMatchObject({ peerId: registry.get('a').id, status: AUDIO_STATUS.READY, allowed: true })
  })

  it('does not tell a player about somebody out of range', () => {
    place('a', 'Ada', 1000, 1000)
    place('b', 'Grace', 2000, 1000, { mic: true })
    expect(eventsFor('a', EVENTS.AUDIO_PEER)).toHaveLength(0)
  })

  it('propagates a mute change to the peer who already sees you', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    place('b', 'Grace', 1030, 1000, { mic: true })
    emitted.length = 0

    audio.setReady('b', { enabled: true, muted: true })
    const notice = lastFor('a', EVENTS.AUDIO_PEER)
    expect(notice).toMatchObject({ name: 'Grace', enabled: true, muted: true })
  })

  it('announces a pair as ready when both sides become eligible in range', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    emitted.length = 0
    place('b', 'Grace', 1050, 1000, { mic: true })

    // Both sides are told, and each is told about the other.
    const forA = lastFor('a', EVENTS.AUDIO_STATUS)
    const forB = lastFor('b', EVENTS.AUDIO_STATUS)
    expect(forA).toMatchObject({ peerId: registry.get('b').id, status: AUDIO_STATUS.READY, allowed: true })
    expect(forB).toMatchObject({ peerId: registry.get('a').id, status: AUDIO_STATUS.READY, allowed: true })
  })

  it('keeps two eligible players out of range unauthorized', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    place('b', 'Grace', 1500, 1000, { mic: true })
    const statuses = [...eventsFor('a', EVENTS.AUDIO_STATUS), ...eventsFor('b', EVENTS.AUDIO_STATUS)]
    expect(statuses.filter((entry) => entry.payload.allowed)).toHaveLength(0)
    expect(audio.describe().allowedPairs).toBe(0)
  })
})

describe('signal authorization', () => {
  it('accepts a signal between two eligible players in range', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })

    const verdict = audio.authorizeSignal('a', grace.id)
    expect(verdict.ok).toBe(true)
    expect(verdict.targetSocketId).toBe('b')
  })

  it('refuses a sender who has not announced a microphone', () => {
    place('a', 'Ada', 1000, 1000)
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })

    expect(audio.authorizeSignal('a', grace.id)).toMatchObject({ ok: false, code: ERROR_CODES.AUDIO_NOT_READY })
  })

  it('refuses a target with no live microphone', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000)

    expect(audio.authorizeSignal('a', grace.id)).toMatchObject({
      ok: false,
      code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE,
    })
  })

  it('refuses a target who is out of earshot', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1400, 1000, { mic: true })

    const verdict = audio.authorizeSignal('a', grace.id)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/out of earshot/i)
  })

  it('refuses a target that does not exist, and refuses self-calls', () => {
    const ada = place('a', 'Ada', 1000, 1000, { mic: true })
    expect(audio.authorizeSignal('a', 'ghost-id')).toMatchObject({ ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE })
    expect(audio.authorizeSignal('a', ada.id)).toMatchObject({ ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE })
  })

  it('never resolves a target through a client-supplied socket id', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })

    // A socket id is not a player id: the service only accepts player ids, which it
    // resolves through the registry itself.
    expect(audio.authorizeSignal('a', 'b')).toMatchObject({ ok: false, code: ERROR_CODES.AUDIO_TARGET_UNAVAILABLE })
    expect(audio.authorizeSignal('a', grace.id)).toMatchObject({ ok: true })
  })
})

describe('relaying', () => {
  it('relays an offer with the sender attributed by the server', () => {
    const adaLive = place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    emitted.length = 0

    const result = audio.relayOffer('a', {
      targetId: grace.id,
      sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    })

    expect(result.ok).toBe(true)
    const [delivered] = eventsFor('b', EVENTS.SIGNAL_OFFER)
    expect(delivered.payload.fromId).toBe(adaLive.id)
    expect(delivered.payload.fromName).toBe('Ada')
    expect(delivered.payload.sdp.type).toBe('offer')
    // The target id is stripped: the receiver learns who called from the server.
    expect(delivered.payload.targetId).toBeUndefined()
    expect(audio.stats.offered).toBe(1)
  })

  it('does not relay anything when the pair is not authorized', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    place('b', 'Grace', 1400, 1000, { mic: true })
    emitted.length = 0

    const result = audio.relayOffer('a', {
      targetId: registry.get('b').id,
      sdp: { type: 'offer', sdp: 'v=0\r\n' },
    })

    expect(result.ok).toBe(false)
    expect(emitted.filter((entry) => entry.event === EVENTS.SIGNAL_OFFER)).toHaveLength(0)
    expect(audio.stats.denied).toBe(1)
  })

  it('keeps a pair alive while both stay inside radius + hysteresis', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: grace.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })

    // Step just outside the radius: the call survives (AUDIO_RELEASE_HYSTERESIS).
    registry.move('b', { x: 1108, y: 1000, moving: true }) // 108 u
    audio.reconcilePlayer('b')
    expect(audio.authorizeSignal('a', grace.id).ok).toBe(true)

    // Beyond radius + hysteresis it does not.
    registry.move('b', { x: 1125, y: 1000, moving: true }) // 125 u
    const { verdicts } = audio.reconcilePlayer('b')
    expect(verdicts.some((verdict) => verdict.allowed === false)).toBe(true)
    expect(audio.authorizeSignal('a', grace.id)).toMatchObject({ ok: false })
  })

  it('tells both sides when a pair is revoked for leaving the radius', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: grace.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    emitted.length = 0

    registry.move('b', { x: 1400, y: 1000, moving: true })
    audio.reconcilePlayer('b')

    expect(lastFor('a', EVENTS.AUDIO_STATUS)).toMatchObject({ status: AUDIO_STATUS.OUT_OF_RANGE, allowed: false })
    expect(lastFor('b', EVENTS.AUDIO_STATUS)).toMatchObject({ status: AUDIO_STATUS.OUT_OF_RANGE, allowed: false })
  })

  it('revokes every pair when a player withdraws their microphone', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: registry.get('b').id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    emitted.length = 0

    audio.setReady('a', { enabled: false, muted: false })

    expect(audio.authorizeSignal('a', registry.get('b').id)).toMatchObject({ ok: false, code: ERROR_CODES.AUDIO_NOT_READY })
    expect(lastFor('b', EVENTS.AUDIO_STATUS).allowed).toBe(false)
  })

  it('closes a pair on request and tells the other side', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: registry.get('b').id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    emitted.length = 0

    const result = audio.closePair('a', registry.get('b').id, 'hangup')
    expect(result.delivered).toBe(true)
    const [close] = eventsFor('b', EVENTS.SIGNAL_CLOSE)
    expect(close.payload).toMatchObject({ fromName: 'Ada', reason: 'hangup' })
    expect(audio.describe().connectedPairs).toBe(0)
  })

  it('treats closing a pair whose peer already left as done, not as an error', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    expect(audio.closePair('a', 'gone-player', 'hangup')).toMatchObject({ ok: true, delivered: false })
  })

  it('counts relayed signalling by kind', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: grace.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    audio.relayAnswer('b', { targetId: registry.get('a').id, sdp: { type: 'answer', sdp: 'v=0\r\n' } })
    audio.relayIce('a', { targetId: grace.id, candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' } })
    audio.relayIce('b', { targetId: registry.get('a').id, candidate: null })

    expect(audio.stats).toMatchObject({ offered: 1, answered: 1, ice: 2, relayed: 4 })
  })
})

describe('disconnects', () => {
  it('tells the survivor that the peer left, and forgets the pair', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: grace.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    emitted.length = 0

    registry.remove('b') // the socket is gone before the service is told
    const dropped = audio.forgetPlayer(grace.id)

    expect(dropped).toHaveLength(1)
    expect(lastFor('a', EVENTS.AUDIO_STATUS)).toMatchObject({ peerId: grace.id, status: AUDIO_STATUS.PEER_LEFT, allowed: false })
    expect(audio.pairsFor(registry.get('a').id)).toHaveLength(0)
  })

  it('does not resurrect a pair when a peer reconnects with a new session id', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const first = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: first.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })
    registry.remove('b')
    audio.forgetPlayer(first.id)

    // Grace comes back: new socket, new player id, same name and place.
    place('c', 'Grace', 1030, 1000, { mic: true })
    expect(audio.authorizeSignal('a', first.id)).toMatchObject({ ok: false })
  })

  it('does not emit a revoke for a player with no pairs', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    emitted.length = 0
    expect(audio.forgetPlayer(registry.get('a').id)).toEqual([])
    expect(emitted).toHaveLength(0)
  })
})

describe('diagnostics', () => {
  it('describes the pairs and their state', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    const grace = place('b', 'Grace', 1030, 1000, { mic: true })
    audio.relayOffer('a', { targetId: grace.id, sdp: { type: 'offer', sdp: 'v=0\r\n' } })

    const description = audio.describe()
    expect(description).toMatchObject({ radius: 100, releaseHysteresis: 12, pairs: 1, allowedPairs: 1, connectedPairs: 1 })
    expect(audio.pairsFor(registry.get('a').id)[0]).toMatchObject({ allowed: true, connected: true })
  })

  it('reset() clears pairs and counters', () => {
    place('a', 'Ada', 1000, 1000, { mic: true })
    audio.setReady('a', { enabled: true, muted: false })
    audio.reset()
    expect(audio.describe()).toMatchObject({ pairs: 0, allowedPairs: 0 })
    expect(audio.stats.readyAnnouncements).toBe(0)
  })
})
