// Integration tests for audio eligibility and WebRTC signalling over a real
// Socket.IO server with real clients.
//
// The security properties under test are the ones a client could otherwise break:
// it cannot claim somebody else's identity in a signal, it cannot reach a peer it
// is not authorized to reach, it cannot push unbounded payloads through the relay,
// and it cannot flood the relay.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { io as ioClient } from 'socket.io-client'
import { createServer } from '../index.js'
import { parseConfig } from '../config/env.js'
import { createLogger } from '../lib/logger.js'
import { EVENTS, LIMITS } from '../../../shared/protocol.js'

const FRONTEND_ORIGIN = 'http://localhost:5173'
const WAIT_TIMEOUT_MS = 5000
const OFFER_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
const ANSWER_SDP = OFFER_SDP.replace('o=- 1 1', 'o=- 2 2')

let httpServer
let baseUrl
let registry
let audio
let serverStats
const clients = new Set()

beforeAll(async () => {
  const config = parseConfig({ NODE_ENV: 'test', CORS_ORIGIN: FRONTEND_ORIGIN, MONGODB_URI: '' })
  const created = createServer({ config, logger: createLogger({ level: 'error', scope: 'test', sink: { write() {} } }) })
  httpServer = created.httpServer
  registry = created.registry
  audio = created.realtime.audio
  serverStats = created.realtime.stats

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
})

afterEach(async () => {
  for (const socket of clients) socket.disconnect()
  const deadline = Date.now() + 2000
  while (registry.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  clients.clear()
  audio.reset()
})

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve))
})

// ------------------------------------------------------------------ helpers ---

function connectClient() {
  const socket = ioClient(baseUrl, { transports: ['websocket'], reconnection: false, timeout: WAIT_TIMEOUT_MS })
  clients.add(socket)
  return socket
}

function waitForEvent(socket, event, { timeout = WAIT_TIMEOUT_MS, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timed out waiting for "${event}"`))
    }, timeout)
    function handler(payload) {
      if (!filter(payload)) return
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

const once = (socket, event, options) => waitForEvent(socket, event, options)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function join(socket, name) {
  const snapshot = once(socket, EVENTS.SNAPSHOT)
  socket.emit(EVENTS.JOIN, { name })
  return (await snapshot).self
}

/** Put a session at an exact position through the registry, then republish. */
function place(socketId, x, y) {
  registry.move(socketId, { x, y, moving: false })
  audio.reconcileAll()
}

/** Announce a live microphone and wait for the server's echo. */
async function enableMic(socket, { muted = false } = {}) {
  const echo = once(socket, EVENTS.AUDIO_PEER, { filter: (payload) => payload.peerId !== undefined })
  socket.emit(EVENTS.AUDIO_READY, { enabled: true, muted })
  await echo
}

// --------------------------------------------------------------------- tests ---

describe('audio eligibility over the wire', () => {
  it('records the declaration and echoes the server\u2019s own view back', async () => {
    const ada = connectClient()
    const self = await join(ada, 'Ada')
    await enableMic(ada, { muted: true })

    const player = registry.getById(self.id)
    expect(player.audio).toEqual({ enabled: true, muted: true })
    expect(serverStats.audioReady).toBe(1)
  })

  it('tells an in-range peer that somebody is now available', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    await join(grace, 'Grace')
    place(grace.id, 1040, 1000)

    // Listen before Grace announces, so the announcement cannot be missed.
    const notice = once(ada, EVENTS.AUDIO_PEER, {
      filter: (payload) => payload.enabled && payload.name === 'Grace',
    })
    const status = once(grace, EVENTS.AUDIO_STATUS, {
      filter: (payload) => payload.status === 'ready' && payload.peerId === adaSelf.id,
    })
    await enableMic(grace)

    // Ada is told Grace is available...
    expect((await notice).allowed).toBe(true) // ...and connectable: Ada has her mic on
    // ...and Grace is told the pair may connect.
    expect((await status).allowed).toBe(true)
  })

  it('does not announce a player who is out of range', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 500, 500)

    const grace = connectClient()
    await join(grace, 'Grace')
    place(grace.id, 2000, 1400)

    // Nothing is expected, so assert the negative over a quiet window: Ada must not
    // hear a word about Grace, who is 2000 u away.
    const seen = []
    const listener = (payload) => seen.push(payload)
    ada.on(EVENTS.AUDIO_PEER, listener)
    grace.emit(EVENTS.AUDIO_READY, { enabled: true, muted: false })
    await sleep(250)
    ada.off(EVENTS.AUDIO_PEER, listener)

    expect(seen.filter((payload) => payload.name === 'Grace')).toHaveLength(0)
    // The server did record Grace's microphone; it is proximity that keeps it quiet.
    expect(registry.get(grace.id).audio.enabled).toBe(true)
  })

  it('rejects a malformed audio announcement', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')

    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.AUDIO_READY, { enabled: 'yes' })
    expect((await error).code).toBe('invalid_payload')
  })

  it('requires joining before announcing audio', async () => {
    const ada = connectClient()
    await once(ada, 'connect')
    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.AUDIO_READY, { enabled: true })
    expect((await error).code).toBe('join_required')
  })
})

describe('signalling authorization over the wire', () => {
  /** Two eligible sessions in range, ready to exchange SDP. */
  async function pair() {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1030, 1000)
    await enableMic(grace)

    return { ada, grace, adaSelf, graceSelf }
  }

  it('relays an offer, an answer and ICE candidates in both directions', async () => {
    const { ada, grace, adaSelf, graceSelf } = await pair()

    const offerAtGrace = once(grace, EVENTS.SIGNAL_OFFER, { filter: (payload) => payload.fromId === adaSelf.id })
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: graceSelf.id, sdp: { type: 'offer', sdp: OFFER_SDP } })
    const offer = await offerAtGrace
    expect(offer.fromId).toBe(adaSelf.id)
    expect(offer.fromName).toBe('Ada')
    expect(offer.sdp.sdp).toBe(OFFER_SDP)
    expect(offer.targetId).toBeUndefined()

    const answerAtAda = once(ada, EVENTS.SIGNAL_ANSWER, { filter: (payload) => payload.fromId === graceSelf.id })
    grace.emit(EVENTS.SIGNAL_ANSWER, { targetId: adaSelf.id, sdp: { type: 'answer', sdp: ANSWER_SDP } })
    expect((await answerAtAda).sdp.sdp).toBe(ANSWER_SDP)

    const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.9 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    const iceAtGrace = once(grace, EVENTS.SIGNAL_ICE, { filter: (payload) => payload.fromId === adaSelf.id })
    ada.emit(EVENTS.SIGNAL_ICE, { targetId: graceSelf.id, candidate })
    expect((await iceAtGrace).candidate).toMatchObject({ candidate: candidate.candidate, sdpMLineIndex: 0 })

    // The end-of-candidates marker is relayed as null, as the browsers expect.
    const endAtAda = once(ada, EVENTS.SIGNAL_ICE, { filter: (payload) => payload.fromId === graceSelf.id })
    grace.emit(EVENTS.SIGNAL_ICE, { targetId: adaSelf.id, candidate: null })
    expect((await endAtAda).candidate).toBeNull()
  })

  it('ignores a client-supplied sender identity completely', async () => {
    const { ada, grace, adaSelf, graceSelf } = await pair()

    const offerAtGrace = once(grace, EVENTS.SIGNAL_OFFER)
    ada.emit(EVENTS.SIGNAL_OFFER, {
      targetId: graceSelf.id,
      // All of these are lies a hostile client might try.
      fromId: graceSelf.id,
      from: 'someone-else',
      id: graceSelf.id,
      sdp: { type: 'offer', sdp: OFFER_SDP },
    })

    const offer = await offerAtGrace
    expect(offer.fromId).toBe(adaSelf.id) // the server's attribution, not the client's
    expect(offer.from).toBeUndefined()
    expect(offer.id).toBeUndefined()
  })

  it('refuses to relay to a peer outside the listening radius', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 400, 400)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 2000, 1400)
    await enableMic(grace)

    const error = once(ada, EVENTS.ERROR)
    const leaked = []
    const listener = (payload) => leaked.push(payload)
    grace.on(EVENTS.SIGNAL_OFFER, listener)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: graceSelf.id, sdp: { type: 'offer', sdp: OFFER_SDP } })

    expect((await error).code).toBe('audio_target_unavailable')
    await sleep(150)
    grace.off(EVENTS.SIGNAL_OFFER, listener)
    expect(leaked).toHaveLength(0)
    expect(serverStats.signalsDenied).toBeGreaterThan(0)
    expect(adaSelf.id).toBeTruthy()
  })

  it('refuses signalling from a client that has not enabled its microphone', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(ada.id, 1000, 1000)
    place(grace.id, 1020, 1000)
    await enableMic(grace)

    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: graceSelf.id, sdp: { type: 'offer', sdp: OFFER_SDP } })
    expect((await error).code).toBe('audio_not_ready')
    expect(adaSelf.audio.enabled).toBe(false)
  })

  it('refuses to relay to a player who does not exist', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    await enableMic(ada)

    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: 'not-a-real-player', sdp: { type: 'offer', sdp: OFFER_SDP } })
    expect((await error).code).toBe('audio_target_unavailable')
  })

  it('refuses to let a client call itself', async () => {
    const ada = connectClient()
    const self = await join(ada, 'Ada')
    await enableMic(ada)

    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: self.id, sdp: { type: 'offer', sdp: OFFER_SDP } })
    expect((await error).code).toBe('audio_target_unavailable')
  })

  it('rejects a mismatched session description type', async () => {
    const { ada, graceSelf } = await pair()
    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: graceSelf.id, sdp: { type: 'answer', sdp: ANSWER_SDP } })
    const payload = await error
    expect(payload.code).toBe('invalid_signal')
    expect(payload.message).toMatch(/offer/)
  })

  it('rejects oversized SDP and malformed candidates', async () => {
    const { ada, graceSelf } = await pair()

    const oversized = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_OFFER, {
      targetId: graceSelf.id,
      sdp: { type: 'offer', sdp: `v=0\r\n${'x'.repeat(LIMITS.SDP_MAX_LENGTH)}` },
    })
    expect((await oversized).code).toBe('invalid_signal')

    const junk = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_ICE, { targetId: graceSelf.id, candidate: { candidate: 'not a candidate line' } })
    expect((await junk).code).toBe('invalid_signal')
  })

  it('rate-limits a signalling flood', async () => {
    const { ada, graceSelf } = await pair()

    const errors = []
    ada.on(EVENTS.ERROR, (payload) => errors.push(payload))
    for (let index = 0; index < 400; index += 1) {
      ada.emit(EVENTS.SIGNAL_ICE, {
        targetId: graceSelf.id,
        candidate: { candidate: `candidate:1 1 udp 1 192.168.1.9 ${index} typ host` },
      })
    }

    const deadline = Date.now() + 2000
    while (!errors.some((payload) => payload.code === 'rate_limited') && Date.now() < deadline) await sleep(20)
    expect(errors.some((payload) => payload.code === 'rate_limited')).toBe(true)
    expect(serverStats.droppedByRateLimit).toBeGreaterThan(0)
  })
})

describe('teardown driven by the server', () => {
  it('revokes a pair when one side walks out of range, telling both', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1030, 1000)
    await enableMic(grace)

    const offerAtGrace = once(grace, EVENTS.SIGNAL_OFFER)
    ada.emit(EVENTS.SIGNAL_OFFER, { targetId: graceSelf.id, sdp: { type: 'offer', sdp: OFFER_SDP } })
    await offerAtGrace

    // Walk Grace well past radius + hysteresis.
    const revokedAtAda = once(ada, EVENTS.AUDIO_STATUS, { filter: (payload) => payload.allowed === false })
    const revokedAtGrace = once(grace, EVENTS.AUDIO_STATUS, { filter: (payload) => payload.allowed === false })
    place(grace.id, 1400, 1000)

    expect((await revokedAtAda).status).toBe('out_of_range')
    expect((await revokedAtGrace).status).toBe('out_of_range')
    expect(adaSelf.id).toBeTruthy()

    // And the relay is closed: no more signalling is accepted for that pair.
    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_ICE, { targetId: graceSelf.id, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host' } })
    expect((await error).code).toBe('audio_target_unavailable')
  })

  it('revokes a pair when a player withdraws their microphone', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1020, 1000)
    await enableMic(grace)

    const revoked = once(grace, EVENTS.AUDIO_STATUS, { filter: (payload) => payload.peerId === adaSelf.id && payload.allowed === false })
    ada.emit(EVENTS.AUDIO_READY, { enabled: false, muted: false })
    expect((await revoked).status).toBe('peer_ineligible')
    expect(graceSelf.id).toBeTruthy()
  })

  it('tells the survivor when a peer disconnects mid-call', async () => {
    const ada = connectClient()
    await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1030, 1000)
    await enableMic(grace)

    const peerLeft = once(ada, EVENTS.AUDIO_STATUS, { filter: (payload) => payload.status === 'peer_left' })
    grace.disconnect()

    const payload = await peerLeft
    expect(payload.peerId).toBe(graceSelf.id)
    expect(payload.allowed).toBe(false)
  })

  it('relays an explicit hang-up to the other side', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    place(ada.id, 1000, 1000)
    await enableMic(ada)

    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(grace.id, 1030, 1000)
    await enableMic(grace)

    const closed = once(grace, EVENTS.SIGNAL_CLOSE, { filter: (payload) => payload.fromId === adaSelf.id })
    ada.emit(EVENTS.SIGNAL_CLOSE, { targetId: graceSelf.id, reason: 'hangup' })
    expect((await closed).reason).toBe('hangup')
  })

  it('rejects an unknown close reason', async () => {
    const ada = connectClient()
    const adaSelf = await join(ada, 'Ada')
    const grace = connectClient()
    const graceSelf = await join(grace, 'Grace')
    place(ada.id, 1000, 1000)
    place(grace.id, 1020, 1000)
    await enableMic(ada)
    await enableMic(grace)

    const error = once(ada, EVENTS.ERROR)
    ada.emit(EVENTS.SIGNAL_CLOSE, { targetId: graceSelf.id, reason: 'because' })
    expect((await error).code).toBe('invalid_signal')
    expect(adaSelf.id).toBeTruthy()
  })
})
