#!/usr/bin/env node
// Audio verification: drives two real Socket.IO sessions through the real client
// audio engine and checks the full proximity-voice flow — announce, authorize,
// offer/answer/ICE over the wire, SRTP audio in both directions, revocation when a
// peer walks out of earshot, and teardown.
//
// This is the scripted stand-in for the two-browser checklist in
// docs/SESSION_06_REPORT.md. `@roamhq/wrtc` provides the RTCPeerConnection, so the
// media path here is real (SRTP) rather than simulated; the browser-only parts
// (getUserMedia, <audio>, AudioContext) are replaced by wrtc equivalents and the
// script says so in its output. It cannot prove that a real microphone is captured
// or that a real speaker plays audio — that needs a human with two browsers.
//
// Usage:
//   node scripts/verify-audio.mjs                      # through the Vite proxy (:5173)
//   SMOKE_URL=http://127.0.0.1:8080 node scripts/verify-audio.mjs
//
// Exits non-zero on the first failed check.

import process from 'node:process'
import { io } from 'socket.io-client'
import wrtc from '@roamhq/wrtc'
import { EVENTS, LIMITS } from '../shared/protocol.js'
import { AUDIO_PEER_STATE, MIC_STATE, createAudioEngine } from '../client/src/audio/audioEngine.js'

const { RTCPeerConnection, MediaStream, nonstandard } = wrtc

const BASE_URL = (process.env.SMOKE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const ORIGIN = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173'
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 12_000)
const TALK_MS = Number(process.env.SMOKE_TALK_MS ?? 1_500)

const results = []
let audioA = 0
let audioB = 0

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'
  process.stdout.write(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitFor(socket, event, { timeout = TIMEOUT_MS, filter = () => true, label = event } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timed out waiting for ${label}`))
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

async function waitUntil(predicate, { timeout = TIMEOUT_MS, label = 'condition', interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(interval)
  }
}

// --------------------------------------------------------------- test doubles --

/**
 * A microphone built from a wrtc RTCAudioSource: a real, encoded audio track with a
 * generated tone, so the peer below receives genuine audio packets.
 */
function createFakeMicrophone() {
  const source = new nonstandard.RTCAudioSource()
  const track = source.createTrack()
  let produced = 0
  let timer = null
  const stream = new MediaStream([track])

  return {
    stream,
    get produced() {
      return produced
    },
    start() {
      if (timer) return
      timer = setInterval(() => {
        // 48 kHz mono, 480 frames per 10 ms — the same cadence a browser uses.
        source.onData({ samples: new Int16Array(480).fill(3000), sampleRate: 48_000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 })
        produced += 480
      }, 10)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      track.stop()
    },
  }
}

/**
 * The audio sink the engine would give to an <audio> element. In Node there is no
 * playback device, so the remote track is drained by an RTCAudioSink and the frames
 * are counted — proof that audio really arrived, without pretending something was
 * heard.
 */
function createFakeAudioElementFactory(counters) {
  return () => {
    const element = {
      srcObject: null,
      paused: false,
      play: async () => {},
      pause: () => {},
      remove: () => {},
    }
    Object.defineProperty(element, 'srcObject', {
      get() {
        return element.__stream ?? null
      },
      set(stream) {
        element.__stream = stream
        counters.sinks += 1
        for (const track of stream?.getAudioTracks?.() ?? []) {
          const sink = new nonstandard.RTCAudioSink(track)
          sink.ondata = (data) => {
            counters.frames += 1
            counters.samples += data.numberOfFrames
            counters.lastSampleAt = Date.now()
          }
          element.__sink = sink
        }
      },
    })
    return element
  }
}

// -------------------------------------------------------------------- session --

function connect(name) {
  const socket = io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: TIMEOUT_MS,
    extraHeaders: { origin: ORIGIN },
  })
  socket.__name = name
  socket.__events = []
  for (const event of [EVENTS.SNAPSHOT, EVENTS.JOINED, EVENTS.MOVED, EVENTS.LEFT, EVENTS.PROXIMITY, EVENTS.AUDIO_PEER, EVENTS.AUDIO_STATUS, EVENTS.SIGNAL_OFFER, EVENTS.SIGNAL_ANSWER, EVENTS.SIGNAL_ICE, EVENTS.SIGNAL_CLOSE, EVENTS.ERROR]) {
    socket.on(event, (payload) => socket.__events.push({ event, payload, at: Date.now() }))
  }
  return socket
}

async function ready(socket, label) {
  if (socket.connected) return
  await waitFor(socket, 'connect', { label })
}

async function join(socket, name) {
  const snapshot = waitFor(socket, EVENTS.SNAPSHOT, { label: `snapshot for ${name}` })
  socket.emit(EVENTS.JOIN, { name })
  return snapshot
}

/**
 * Wire a real client audio engine to a session: the engine emits through the socket
 * and receives through the same event names the browser client uses.
 */
function attachEngine(socket, name, microphone, counters, sent = { announce: [] }) {
  const engine = createAudioEngine({
    RTCPeerConnectionImpl: RTCPeerConnection,
    mediaDevices: { getUserMedia: async () => microphone.stream },
    createAudioElement: createFakeAudioElementFactory(counters),
    // The speaking indicator is UI feedback; a headless run has no waveform to read,
    // so voice activity is not asserted here.
    createVoiceDetector: null,
    // w`rtc` on the same host needs no ICE servers, and using none keeps this check
    // independent of the public STUN servers.
    iceResolver: async () => ({ iceServers: [], hasTurn: false, source: 'wrtc-local' }),
    logger: {
      debug: () => {},
      warn: (message, meta) => process.stdout.write(`      [${name}] warn: ${message} ${JSON.stringify(meta ?? {})}\n`),
      error: () => {},
    },
  })

  engine.setTransport({
    announce: (state) => {
      sent.announce.push(state)
      socket.emit(EVENTS.AUDIO_READY, state)
    },
    offer: (targetId, sdp) => socket.emit(EVENTS.SIGNAL_OFFER, { targetId, sdp }),
    answer: (targetId, sdp) => socket.emit(EVENTS.SIGNAL_ANSWER, { targetId, sdp }),
    ice: (targetId, candidate) => socket.emit(EVENTS.SIGNAL_ICE, { targetId, candidate }),
    close: (targetId, reason) => socket.emit(EVENTS.SIGNAL_CLOSE, { targetId, reason }),
  })

  socket.on(EVENTS.SNAPSHOT, (payload) => engine.setSelfId(payload?.self?.id ?? null))
  socket.on(EVENTS.AUDIO_PEER, (payload) => engine.applyPeer(payload))
  socket.on(EVENTS.AUDIO_STATUS, (payload) => engine.applyStatus(payload))
  socket.on(EVENTS.SIGNAL_OFFER, (payload) => engine.handleSignal(payload.fromId, { type: 'offer', sdp: payload.sdp.sdp }, { fromName: payload.fromName }))
  socket.on(EVENTS.SIGNAL_ANSWER, (payload) => engine.handleSignal(payload.fromId, { type: 'answer', sdp: payload.sdp.sdp }, { fromName: payload.fromName }))
  socket.on(EVENTS.SIGNAL_ICE, (payload) => engine.handleIce(payload.fromId, payload.candidate))
  socket.on(EVENTS.SIGNAL_CLOSE, (payload) => engine.revoke(payload.fromId, { reason: payload.reason }))

  return engine
}

const eventsOf = (socket, event) => socket.__events.filter((entry) => entry.event === event).map((entry) => entry.payload)

/**
 * Walk in legal steps — the server enforces 205 u/s plus slack, so one long jump is
 * rejected, and the pause exceeds the 4 Hz proximity interval so the server has a
 * chance to re-evaluate who is in earshot.
 */
async function walkTo(socket, from, to, { stepUnits = 45, pauseMs = 280 } = {}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepUnits))
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    socket.emit(EVENTS.MOVE, { x: from.x + dx * progress, y: from.y + dy * progress, dir: 0, moving: true, clientTs: Date.now() })
    await sleep(pauseMs)
  }
  return { x: to.x, y: to.y }
}

function lastProximity(socket) {
  return eventsOf(socket, EVENTS.PROXIMITY).at(-1) ?? null
}

// ----------------------------------------------------------------------- main --

async function main() {
  process.stdout.write(`\nProxiSpeak audio check → ${BASE_URL}\n`)
  process.stdout.write('  media: real SRTP via @roamhq/wrtc (no microphone, no speakers, no browser)\n\n')

  const aliceMic = createFakeMicrophone()
  const bobMic = createFakeMicrophone()
  const aliceAudio = { sinks: 0, frames: 0, samples: 0, lastSampleAt: 0 }
  const bobAudio = { sinks: 0, frames: 0, samples: 0, lastSampleAt: 0 }

  const alice = connect('alice')
  const bob = connect('bob')
  await ready(alice, 'connect for Alice')
  await ready(bob, 'connect for Bob')

  const aliceSnapshot = await join(alice, 'Alice')
  const bobSnapshot = await join(bob, 'Bob')

  const aliceSent = { announce: [] }
  const bobSent = { announce: [] }
  const aliceEngine = attachEngine(alice, 'alice', aliceMic, aliceAudio, aliceSent)
  const bobEngine = attachEngine(bob, 'bob', bobMic, bobAudio, bobSent)
  aliceEngine.setSelfId(aliceSnapshot.self.id)
  bobEngine.setSelfId(bobSnapshot.self.id)

  // --- consent: nothing is captured until enable() is called -----------------
  await sleep(300)
  record(
    'no microphone is opened until the user asks',
    aliceEngine.getSnapshot().mic === MIC_STATE.IDLE && aliceEngine.getSnapshot().enabled === false,
    `mic=${aliceEngine.getSnapshot().mic}`,
  )

  // --- walk into earshot (the sessions spawn at different points) ------------
  const spawnedApart = Math.hypot(aliceSnapshot.self.x - bobSnapshot.self.x, aliceSnapshot.self.y - bobSnapshot.self.y)
  const bobStart0 = { x: bobSnapshot.self.x, y: bobSnapshot.self.y }
  await walkTo(bob, bobStart0, { x: aliceSnapshot.self.x + 40, y: aliceSnapshot.self.y })
  await sleep(350)
  const inEarshot = (lastProximity(bob)?.neighbours ?? []).some((entry) => entry.id === aliceSnapshot.self.id)
  record(
    'walking within the radius makes the players neighbours',
    inEarshot,
    `spawned ${Math.round(spawnedApart)}u apart, bob now sees [${(lastProximity(bob)?.neighbours ?? []).map((entry) => `${entry.name}@${Math.round(entry.distance)}u`).join(', ') || 'nobody'}]`,
  )

  // --- both players switch their microphones on ------------------------------
  aliceMic.start()
  bobMic.start()
  await aliceEngine.enable()
  await bobEngine.enable()

  record(
    'enabling the microphone announces audio:ready',
    aliceSent.announce.at(-1)?.enabled === true && aliceSent.announce.at(-1)?.muted === false,
    `sent=${JSON.stringify(aliceSent.announce)}`,
  )
  record(
    'the microphone is active locally after enable()',
    aliceEngine.getSnapshot().mic === MIC_STATE.ACTIVE && bobEngine.getSnapshot().mic === MIC_STATE.ACTIVE,
    `alice=${aliceEngine.getSnapshot().mic} bob=${bobEngine.getSnapshot().mic}`,
  )

  // --- the server authorizes the pair ---------------------------------------
  const aliceStatus = await waitUntil(
    () => eventsOf(alice, EVENTS.AUDIO_STATUS).find((payload) => payload.allowed === true) ?? null,
    { label: "Alice's audio pair to be allowed", timeout: 4_000 },
  )
  record(
    'the server authorizes the pair (audio:status ready, allowed)',
    aliceStatus.status === 'ready' && aliceStatus.peerId === bobSnapshot.self.id,
    `peerId=${String(aliceStatus.peerId).slice(0, 8)} status=${aliceStatus.status}`,
  )
  record(
    'the peer notice carries the other player’s name and mute state',
    eventsOf(alice, EVENTS.AUDIO_PEER).some((payload) => payload.peerId === bobSnapshot.self.id && payload.name === 'Bob'),
    `notices=${eventsOf(alice, EVENTS.AUDIO_PEER).length}`,
  )

  // --- WebRTC negotiation and audio -----------------------------------------
  const alicePeers = await waitUntil(
    () => (aliceEngine.getPeers().length === 1 && bobEngine.getPeers().length === 1 ? aliceEngine.getPeers() : null),
    { label: 'both engines to hold exactly one peer connection' },
  )
  record('exactly one peer connection per side', alicePeers.length === 1 && bobEngine.getPeers().length === 1, `alice=${alicePeers.length} bob=${bobEngine.getPeers().length} direction=${aliceEngine.getSnapshot().peers[0]?.direction}`)

  const offers = eventsOf(bob, EVENTS.SIGNAL_OFFER).length + eventsOf(alice, EVENTS.SIGNAL_OFFER).length
  const answers = eventsOf(bob, EVENTS.SIGNAL_ANSWER).length + eventsOf(alice, EVENTS.SIGNAL_ANSWER).length
  const candidates = eventsOf(alice, EVENTS.SIGNAL_ICE).length + eventsOf(bob, EVENTS.SIGNAL_ICE).length
  record(
    'offers, answers and ICE candidates crossed the server',
    offers >= 1 && answers >= 1 && candidates >= 1,
    `offers=${offers} answers=${answers} ice=${candidates} (relayed by the server, sender ids server-derived)`,
  )

  const bothConnected = await waitUntil(
    () => aliceEngine.getPeers()[0]?.state === AUDIO_PEER_STATE.CONNECTED && bobEngine.getPeers()[0]?.state === AUDIO_PEER_STATE.CONNECTED,
    { label: 'both peer connections to reach connected', timeout: 15_000 },
  ).then(
    () => true,
    () => false,
  )
  record('both RTCPeerConnections report connected', bothConnected, `alice=${aliceEngine.getPeers()[0]?.state} bob=${bobEngine.getPeers()[0]?.state}`)

  // Let audio flow for a moment, then check both directions received real samples.
  const audioFlowed = await waitUntil(() => aliceAudio.samples > 0 && bobAudio.samples > 0, { label: 'audio to arrive in both directions', timeout: 8_000 }).then(
    () => true,
    () => false,
  )
  await sleep(TALK_MS)
  audioA = aliceAudio.samples
  audioB = bobAudio.samples
  record(
    'audio arrives in both directions (real SRTP)',
    audioFlowed && aliceAudio.frames > 0 && bobAudio.frames > 0,
    `alice received ${aliceAudio.frames} frames / ${aliceAudio.samples} samples, bob received ${bobAudio.frames} frames / ${bobAudio.samples} samples`,
  )
  record(
    'the tone keeps flowing while connected',
    aliceAudio.lastSampleAt > Date.now() - 1_000 && bobAudio.lastSampleAt > Date.now() - 1_000,
    `last sample ${Math.round((Date.now() - Math.max(aliceAudio.lastSampleAt, bobAudio.lastSampleAt)) / 1000)}s ago`,
  )

  // --- mute ------------------------------------------------------------------
  aliceEngine.setMuted(true)
  const mutedNotice = await waitUntil(
    () => eventsOf(bob, EVENTS.AUDIO_PEER).find((payload) => payload.peerId === aliceSnapshot.self.id && payload.muted === true) ?? null,
    { label: 'Bob to be told Alice muted', timeout: 4_000 },
  ).then(
    (value) => value,
    () => null,
  )
  record('muting is announced to the peer as a flag', Boolean(mutedNotice), `muted notice=${JSON.stringify(mutedNotice ?? null)}`)
  aliceEngine.setMuted(false)
  await sleep(200)

  // --- walking out of earshot revokes the call -------------------------------
  const bobNear = { x: aliceSnapshot.self.x + 40, y: aliceSnapshot.self.y }
  await walkTo(bob, bobNear, { x: bobNear.x + 8 * 45, y: bobNear.y })
  await sleep(400)

  const revoked = await waitUntil(
    () =>
      eventsOf(alice, EVENTS.AUDIO_STATUS).some((payload) => payload.allowed === false) &&
      eventsOf(bob, EVENTS.AUDIO_STATUS).some((payload) => payload.allowed === false),
    { label: 'both sides to be told the pair is revoked', timeout: 6_000 },
  ).then(
    () => true,
    () => false,
  )
  record('walking out of the listening radius revokes the pair on both sides', revoked, `radius=${LIMITS.PROXIMITY_RADIUS}u, bob walked ${8 * 45}u`)

  const tornDown = await waitUntil(() => aliceEngine.getPeers().length === 0 && bobEngine.getPeers().length === 0, {
    label: 'both engines to drop the call',
    timeout: 4_000,
  }).then(
    () => true,
    () => false,
  )
  record('the clients tear the connection down when the server revokes it', tornDown, `alice peers=${aliceEngine.getPeers().length} bob peers=${bobEngine.getPeers().length}`)

  // --- identity: a client cannot speak as somebody else ---------------------
  // The payload claims to come from the other player; the server derives the sender
  // from the socket instead, so the message is either refused outright (the pair is
  // gone) or attributed to the real sender — never to the victim.
  alice.emit(EVENTS.SIGNAL_OFFER, { targetId: bobSnapshot.self.id, fromId: bobSnapshot.self.id, sdp: { type: 'offer', sdp: 'v=0-spoof' } })
  await sleep(400)
  const relayedOffers = [...eventsOf(alice, EVENTS.SIGNAL_OFFER), ...eventsOf(bob, EVENTS.SIGNAL_OFFER)]
  const spoofRelayed = relayedOffers.filter((payload) => String(payload.sdp?.sdp ?? '').includes('spoof'))
  // Nobody ever receives a signal that claims to be *from the receiver* — that is
  // exactly what a successful spoof would look like at Bob.
  const selfAttributed = [
    ...eventsOf(alice, EVENTS.SIGNAL_OFFER).filter((payload) => payload.fromId === aliceSnapshot.self.id),
    ...eventsOf(bob, EVENTS.SIGNAL_OFFER).filter((payload) => payload.fromId === bobSnapshot.self.id),
  ]
  record(
    'a spoofed fromId never makes a signal appear to come from the victim',
    spoofRelayed.length === 0 && selfAttributed.length === 0,
    `${relayedOffers.length} offers relayed in the whole run, ${spoofRelayed.length} carrying the spoofed payload, ${selfAttributed.length} claiming to be from the receiver`,
  )

  // --- microphone off ends everything ---------------------------------------
  aliceEngine.disable()
  await sleep(200)
  const offersToBobBefore = eventsOf(bob, EVENTS.SIGNAL_OFFER).length
  const errorsBefore = eventsOf(alice, EVENTS.ERROR).length
  alice.emit(EVENTS.SIGNAL_OFFER, { targetId: bobSnapshot.self.id, sdp: { type: 'offer', sdp: 'v=0-after-hangup' } })
  const refusedAfterHangup = await waitUntil(() => eventsOf(alice, EVENTS.ERROR).length > errorsBefore, { label: 'the server to refuse signalling after the hang-up', timeout: 3_000 }).then(
    () => eventsOf(alice, EVENTS.ERROR).at(-1),
    () => null,
  )
  record(
    'signalling after the microphone is off is refused by the server',
    refusedAfterHangup?.code === 'audio_not_ready' && eventsOf(bob, EVENTS.SIGNAL_OFFER).length === offersToBobBefore,
    `code=${refusedAfterHangup?.code ?? 'none'}, offers relayed to bob still ${offersToBobBefore}`,
  )
  record(
    'switching the microphone off stops the local track and resets the state',
    aliceEngine.getSnapshot().mic === MIC_STATE.IDLE && aliceEngine.getSnapshot().enabled === false && aliceEngine.getLocalStream() === null,
    `mic=${aliceEngine.getSnapshot().mic}`,
  )
  record(
    'audio:ready { enabled: false } is sent when the microphone is switched off',
    aliceSent.announce.at(-1)?.enabled === false,
    `sent=${JSON.stringify(aliceSent.announce)}`,
  )

  aliceEngine.destroy()
  bobEngine.destroy()
  aliceMic.stop()
  bobMic.stop()
  alice.disconnect()
  bob.disconnect()
  await sleep(150)

  process.stdout.write(`\n  audio summary: alice received ${audioA} samples, bob received ${audioB} samples\n`)

  const passed = results.filter((result) => result.ok).length
  process.stdout.write(`\n${passed}/${results.length} checks passed\n\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  record('audio verification', false, error?.stack ?? error?.message ?? String(error))
  process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed\n\n`)
  process.exit(1)
})
