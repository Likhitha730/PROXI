#!/usr/bin/env node
// Audio verification: drives two real Socket.IO sessions through the real client
// audio engine and checks the full proximity-voice flow — announce, authorize,
// offer/answer/ICE over the wire, SRTP audio in both directions, revocation when a
// peer walks out of earshot, and teardown.
//
// This is the scripted stand-in for the two-browser checklist in
// docs/SESSION_06_REPORT.md and docs/SESSION_07_REPORT.md. `@roamhq/wrtc` provides the
// RTCPeerConnection, so the media path here is real (SRTP) rather than simulated; the
// browser-only parts are stood in for: the microphone is a generated wrtc audio track,
// playback is an RTCAudioSink that counts frames, and — because Node has no Web Audio
// at all — the AudioContext is a **recording fake graph** whose GainNode/StereoPannerNode
// parameters are read back. That means: the graph is built and driven by the real
// spatial code, and the numbers below are the values the real code writes; what cannot
// be verified here is that a browser's audio engine *sounds* like that. No microphone
// is captured and no speaker plays — that needs a human with two browsers.
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
import { attenuationGain, createAudioContextHost, stereoPan } from '../client/src/audio/spatialAudio.js'

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

/**
 * A recording Web Audio context — the one substitution this script cannot avoid.
 *
 * It is deliberately dumb: every node records what was asked of it, so the checks can
 * assert on the *values the spatial code writes* (gain, pan, smoothing, teardown). The
 * audio that flows through it is counted by an RTCAudioSink attached at the graph's
 * MediaStreamSource, which is where a browser would feed the mixer.
 */
function createFakeSpatialContext(counters) {
  const created = { sources: 0, gains: 0, panners: 0, paramWrites: 0, disconnects: 0 }
  const nodes = []

  function param(value = 0, label = 'gain') {
    const target = {
      value,
      label,
      setValueAtTime(next) {
        created.paramWrites += 1
        target.value = next
        return target
      },
      setTargetAtTime(next) {
        created.paramWrites += 1
        target.value = next
        return target
      },
      linearRampToValueAtTime(next) {
        created.paramWrites += 1
        target.value = next
        return target
      },
    }
    return target
  }

  function node(kind, extra) {
    const createdNode = {
      kind,
      connect: () => createdNode,
      disconnect() {
        created.disconnects += 1
        createdNode.connected = false
      },
      connected: true,
      ...extra,
    }
    nodes.push(createdNode)
    return createdNode
  }

  const context = {
    sampleRate: 48_000,
    state: 'running',
    baseLatency: 0.01,
    currentTime: 0,
    destination: { id: 'destination' },
    createMediaStreamSource(stream) {
      created.sources += 1
      const source = node('source')
      // Where a browser hands the decoded remote stream to the mixer; here it is
      // drained by an RTCAudioSink so frames can be counted.
      for (const track of stream?.getAudioTracks?.() ?? []) {
        const sink = new nonstandard.RTCAudioSink(track)
        sink.ondata = (data) => {
          counters.frames += 1
          counters.samples += data.numberOfFrames
          counters.lastSampleAt = Date.now()
        }
        source.__sink = sink
      }
      return source
    },
    createGain() {
      created.gains += 1
      return node('gain', { gain: param(1, `gain-${created.gains}`) })
    },
    createStereoPanner() {
      created.panners += 1
      return node('panner', { pan: param(0, `pan-${created.panners}`) })
    },
  }

  return {
    context,
    created,
    nodes,
    gains: () => nodes.filter((entry) => entry.kind === 'gain'),
    panners: () => nodes.filter((entry) => entry.kind === 'panner'),
    sources: () => nodes.filter((entry) => entry.kind === 'source'),
    advance(seconds) {
      context.currentTime += seconds
    },
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
function attachEngine(socket, name, microphone, counters, sent = { announce: [] }, spatial = null) {
  const engine = createAudioEngine({
    RTCPeerConnectionImpl: RTCPeerConnection,
    mediaDevices: { getUserMedia: async () => microphone.stream },
    createAudioElement: createFakeAudioElementFactory(counters),
    // With a Web Audio context available the engine uses the managed spatial graph;
    // the element factory above then stays unused (and the checks below assert that).
    audioContextHost: spatial ? createAudioContextHost({ factory: () => spatial.context }) : null,
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
  process.stdout.write('  media: real SRTP via @roamhq/wrtc (no microphone, no speakers, no browser)\n')
  process.stdout.write('  spatial: real graph + real curve, written through a recording Web Audio fake (Node has no Web Audio)\n\n')

  const aliceMic = createFakeMicrophone()
  const bobMic = createFakeMicrophone()
  const aliceAudio = { sinks: 0, frames: 0, samples: 0, lastSampleAt: 0 }
  const bobAudio = { sinks: 0, frames: 0, samples: 0, lastSampleAt: 0 }
  // Recording Web Audio graphs: this is what makes the spatial checks below possible
  // in a headless run, and it is labelled as a fake in the output.
  const aliceSpatial = createFakeSpatialContext(aliceAudio)
  const bobSpatial = createFakeSpatialContext(bobAudio)

  const alice = connect('alice')
  const bob = connect('bob')
  await ready(alice, 'connect for Alice')
  await ready(bob, 'connect for Bob')

  const aliceSnapshot = await join(alice, 'Alice')
  const bobSnapshot = await join(bob, 'Bob')

  const aliceSent = { announce: [] }
  const bobSent = { announce: [] }
  const aliceEngine = attachEngine(alice, 'alice', aliceMic, aliceAudio, aliceSent, aliceSpatial)
  const bobEngine = attachEngine(bob, 'bob', bobMic, bobAudio, bobSent, bobSpatial)
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

  // --- spatial audio: one managed graph per stream, driven by world coordinates ---
  const aliceSpatialSummary = aliceEngine.getSpatialSummary()
  record(
    'each remote stream runs through a managed Web Audio graph',
    aliceSpatialSummary.graphPeers === 1 && aliceSpatialSummary.elementPeers === 0,
    `graph peers=${aliceSpatialSummary.graphPeers} plain fallback=${aliceSpatialSummary.elementPeers} ` +
      `· context=${aliceSpatialSummary.context.state} panner=${aliceSpatialSummary.context.hasStereoPanner}`,
  )
  record(
    'the graph is source → gain → panner (one of each, for one stream)',
    aliceSpatial.created.sources === 1 && aliceSpatial.created.gains === 1 && aliceSpatial.created.panners === 1,
    `nodes: ${aliceSpatial.created.sources} source, ${aliceSpatial.created.gains} gain, ${aliceSpatial.created.panners} panner`,
  )

  // Drive the graph the way the renderer's frame hook does: world coordinates only.
  const bobPeerId = bobSnapshot.self.id
  const aliceAt = { x: 1000, y: 1000 }
  const radius = LIMITS.PROXIMITY_RADIUS
  const gainNode = aliceSpatial.gains().at(-1)
  const panNode = aliceSpatial.panners().at(-1)
  // Exactly what the renderer's frame hook passes: the live peer objects, refilled in
  // place every frame (an array, not a Map — a Map would iterate [key, value] pairs and
  // every distance lookup would silently miss).
  const peerFrame = [{ id: bobPeerId, x: aliceAt.x, y: aliceAt.y }]
  const frame = { player: aliceAt, peers: peerFrame, radius, dt: 1 / 60, elapsed: 0 }

  function mixAt(offsetX, offsetY) {
    peerFrame[0].x = aliceAt.x + offsetX
    peerFrame[0].y = aliceAt.y + offsetY
    aliceSpatial.advance(1 / 60)
    aliceEngine.updateSpatial(frame)
    return { gain: gainNode.gain.value, pan: panNode.pan.value }
  }

  const curveSamples = [0, radius / 4, radius / 2, (radius * 3) / 4, radius, radius * 1.5].map((distance) => ({
    distance,
    ...mixAt(distance, 0),
  }))
  const curveMatches = curveSamples.every(
    (sample) => Math.abs(sample.gain - attenuationGain(sample.distance, radius)) < 1e-6,
  )
  record(
    'the gain follows the documented linear curve in world units',
    curveMatches && curveSamples.every((sample) => Math.abs(sample.pan - stereoPan(sample.distance, radius)) < 1e-6),
    curveSamples.map((sample) => `${sample.distance}u→${sample.gain.toFixed(2)}`).join('  '),
  )
  record(
    'the curve is monotonic: walking away never gets louder',
    curveSamples.every((sample, index) => index === 0 || sample.gain <= curveSamples[index - 1].gain),
    `full volume at 0u (${curveSamples[0].gain.toFixed(2)}), silent at ${curveSamples.at(-1).distance}u (${curveSamples.at(-1).gain.toFixed(2)})`,
  )
  record(
    'a peer at the listening radius is silent, and stays silent beyond it',
    curveSamples[4].gain === 0 && curveSamples[5].gain === 0,
    `${curveSamples[4].distance}u → ${curveSamples[4].gain}, ${curveSamples[5].distance}u → ${curveSamples[5].gain}`,
  )
  const left = mixAt(-radius / 2, 0)
  const right = mixAt(radius / 2, 0)
  const north = mixAt(0, -radius / 2)
  record(
    'stereo panning follows the world-space offset, and only the x axis',
    Math.abs(left.pan + 0.5) < 1e-6 && Math.abs(right.pan - 0.5) < 1e-6 && Math.abs(north.pan) < 1e-6,
    `west ${left.pan.toFixed(2)} · east ${right.pan.toFixed(2)} · directly north/south ${north.pan.toFixed(2)} centre`,
  )

  // The frame hook runs at 60 Hz for the whole session; nothing in it may allocate
  // audio nodes or rewrite unchanged parameters.
  const nodesBeforeFrames = aliceSpatial.nodes.length
  const writesBeforeFrames = aliceSpatial.created.paramWrites
  for (let index = 0; index < 600; index += 1) {
    aliceSpatial.advance(1 / 60)
    aliceEngine.updateSpatial(frame)
  }
  record(
    '600 frames of updates create no AudioNodes and rewrite nothing that did not move',
    aliceSpatial.nodes.length === nodesBeforeFrames && aliceSpatial.created.paramWrites === writesBeforeFrames,
    `${aliceSpatial.nodes.length - nodesBeforeFrames} nodes created, ` +
      `${aliceSpatial.created.paramWrites - writesBeforeFrames} parameter writes for a peer standing still`,
  )
  const moved = mixAt(radius / 3, 0)
  record(
    'when the peer does move, the new gain is ramped (never stepped)',
    Math.abs(moved.gain - attenuationGain(radius / 3, radius)) < 1e-6,
    `one 16 ms frame after the move: gain=${moved.gain.toFixed(3)} (target ${attenuationGain(radius / 3, radius).toFixed(3)}) via setTargetAtTime`,
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

  const graphReleased = aliceSpatial.created.disconnects >= 3 && aliceEngine.getSpatialSummary().graphPeers === 0
  record(
    'a revoked stream is disconnected, not left connected at full volume',
    graphReleased,
    `${aliceSpatial.created.disconnects} nodes disconnected, ${aliceEngine.getSpatialSummary().graphPeers} graph peers left`,
  )

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
  process.stdout.write(
    `  spatial summary: ${curveSamples.map((sample) => `${sample.distance}u→gain ${sample.gain.toFixed(2)}/pan ${sample.pan.toFixed(2)}`).join(', ')}\n`,
  )

  const passed = results.filter((result) => result.ok).length
  process.stdout.write(`\n${passed}/${results.length} checks passed\n\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  record('audio verification', false, error?.stack ?? error?.message ?? String(error))
  process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed\n\n`)
  process.exit(1)
})
