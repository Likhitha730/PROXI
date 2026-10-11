// Audio engine — the client side of proximity voice.
//
// Responsibilities, in one place so the rules are reviewable:
//
//   * ask for the microphone **only** from a user gesture (`enable()`),
//   * hold one RTCPeerConnection per authorized peer, never two,
//   * negotiate without glare (see "perfect negotiation" below),
//   * attach remote tracks to managed <audio> elements,
//   * detect who is speaking (local and remote) for the UI indicators,
//   * tear everything down when the server revokes a pair, a peer leaves, or the
//     user disables the microphone.
//
// It is deliberately free of React and of the socket: the net layer injects a
// transport and forwards events, so this module can be tested against fake
// RTCPeerConnection / mediaDevices / AudioContext implementations.
//
// Perfect negotiation (docs/ARCHITECTURE.md §8): both peers may decide to call at
// the same moment, so the two roles are derived deterministically from the player
// ids — the peer with the lexicographically smaller id is the *impolite* one (it
// keeps its own offer), the other is polite and rolls back when an offer arrives
// while it has a local offer outstanding. Combined with making a fresh offer only
// when we are the impolite side (or when an answer is expected), this removes
// duplicate peer connections without any extra round trip.

import { LIMITS } from '../../../shared/protocol.js'
import { resolveIceServers } from './iceConfig.js'
import { createVoiceDetector as createDefaultVoiceDetector } from './voiceActivity.js'

/** Connection states surfaced to the UI (never inferred from audio contents). */
export const AUDIO_PEER_STATE = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  CLOSED: 'closed',
})

/** Microphone lifecycle, surfaced to the UI. */
export const MIC_STATE = Object.freeze({
  IDLE: 'idle',
  REQUESTING: 'requesting',
  ACTIVE: 'active',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
})

const INITIAL_SNAPSHOT = Object.freeze({
  mic: MIC_STATE.IDLE,
  micError: null,
  error: null,
  muted: false,
  enabled: false,
  peers: Object.freeze([]),
  iceSource: null,
  hasTurn: false,
})

/** Audio constraints: voice, with the browser's own processing where available. */
const AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
})

/**
 * Distinguish "the user said no" from "there is no microphone" from "something
 * else broke", because the UI has something different to say in each case.
 */
function classifyMicError(error) {
  const name = error?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return MIC_STATE.DENIED
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return MIC_STATE.UNAVAILABLE
  }
  return MIC_STATE.ERROR
}

function micErrorMessage(state, error) {
  switch (state) {
    case MIC_STATE.DENIED:
      return 'Microphone permission was denied. Allow it in your browser to talk to people nearby.'
    case MIC_STATE.UNAVAILABLE:
      return 'No microphone was found. Plug one in, then try again.'
    case MIC_STATE.ERROR:
      return error?.message
        ? `The microphone could not be started: ${error.message}`
        : 'The microphone could not be started.'
    default:
      return null
  }
}

function defaultAudioElementFactory() {
  if (typeof document === 'undefined') return null
  const element = document.createElement('audio')
  element.autoplay = true
  element.playsInline = true
  element.setAttribute('data-proxi-peer', 'audio')
  // Not `display:none`: some browsers pause elements that are not rendered.
  element.style.position = 'absolute'
  element.style.width = '1px'
  element.style.height = '1px'
  element.style.opacity = '0'
  element.style.pointerEvents = 'none'
  document.body.appendChild(element)
  return element
}

/** Best-effort MediaStream around a single track (null when unsupported). */
function streamFromTrack(track) {
  const Ctor = globalThis.MediaStream
  if (!Ctor || !track) return null
  try {
    return new Ctor([track])
  } catch {
    return null
  }
}

/**
 * @param {{
 *   RTCPeerConnectionImpl?: typeof RTCPeerConnection,
 *   mediaDevices?: MediaDevices,
 *   createAudioElement?: () => HTMLAudioElement,
 *   createVoiceDetector?: (stream: MediaStream, onSpeaking: (speaking: boolean) => void) => ({ stop: () => void } | null),
 *   iceResolver?: typeof resolveIceServers,
 *   now?: () => number,
 *   logger?: { debug: Function, warn: Function, error: Function },
 }} [options]
 */
export function createAudioEngine({
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  mediaDevices = globalThis.navigator?.mediaDevices ?? null,
  createAudioElement = defaultAudioElementFactory,
  createVoiceDetector = createDefaultVoiceDetector,
  iceResolver = resolveIceServers,
  now = () => Date.now(),
  logger = null,
} = {}) {
  /** @type {Map<string, object>} peerId -> { pc, state, remoteStream, audioElement, detectors } */
  const peers = new Map()
  const listeners = new Set()

  let snapshot = INITIAL_SNAPSHOT
  let localStream = null
  let localDetector = null
  let micState = MIC_STATE.IDLE
  let micError = null
  let muted = false
  let enabled = false
  let iceConfig = null
  let localSpeaking = false
  let lastError = null
  let generation = 0

  /** Injected by the net layer; every outbound message goes through it. */
  let transport = {
    announce: () => {},
    offer: () => {},
    answer: () => {},
    ice: () => {},
    close: () => {},
  }

  const log = logger ?? { debug: () => {}, warn: () => {}, error: () => {} }

  // ------------------------------------------------------------- snapshot ---

  /**
   * Per-peer voice flags, keyed by player id. Kept beside the snapshot so the
   * renderer can stamp "speaking"/"muted" onto the avatars it draws each frame
   * without the React tree re-rendering per frame.
   */
  const voiceMap = new Map()

  function rebuildSnapshot(patch = {}) {
    voiceMap.clear()
    for (const entry of peers.values()) {
      voiceMap.set(entry.id, { speaking: Boolean(entry.speaking), muted: Boolean(entry.muted), state: entry.state })
    }
    const peerList = [...peers.values()].map((entry) =>
      Object.freeze({
        id: entry.id,
        name: entry.name,
        state: entry.state,
        muted: entry.muted,
        speaking: entry.speaking,
        direction: entry.polite ? 'polite' : 'impolite',
      }),
    )
    snapshot = Object.freeze({
      ...INITIAL_SNAPSHOT,
      mic: micState,
      micError,
      error: lastError,
      muted,
      enabled,
      iceSource: iceConfig?.source ?? null,
      hasTurn: Boolean(iceConfig?.hasTurn),
      peers: Object.freeze(peerList),
      ...patch,
    })
    for (const listener of listeners) listener()
    return snapshot
  }

  function updatePeerSnapshot(id, patch) {
    const entry = peers.get(id)
    if (!entry) return
    Object.assign(entry, patch)
    rebuildSnapshot()
  }


  /**
   * Attach a remote stream to an <audio> element.
   *
   * Autoplay can be blocked until the user has interacted with the page; because
   * enabling the microphone *is* that interaction, a rejection here is rare — when
   * it happens the peer is flagged so the UI can offer a play button instead of
   * silently playing nothing.
   */
  function attachRemoteStream(id, stream) {
    const entry = peers.get(id)
    if (!entry || !stream) return
    entry.remoteStream = stream
    if (!entry.audioElement) entry.audioElement = createAudioElement?.() ?? null
    const element = entry.audioElement
    if (!element) return

    element.srcObject = stream
    const played = element.play?.()
    if (played?.catch) {
      played.catch((error) => {
        // Never fatal, and never about audio *content* — just autoplay policy.
        updatePeerSnapshot(id, { blocked: true })
        log.warn('remote audio could not autoplay', { peerId: id, reason: error?.name })
      })
    }
  }

  function releaseRemoteStream(id) {
    const entry = peers.get(id)
    if (!entry) return
    entry.mediaDetector?.stop?.()
    entry.mediaDetector = null
    if (entry.audioElement) {
      try {
        entry.audioElement.srcObject = null
        entry.audioElement.pause?.()
      } catch {
        /* the element may already be detached */
      }
      entry.audioElement.remove?.()
      entry.audioElement = null
    }
    entry.remoteStream = null
  }

  // -------------------------------------------------------------- peers ---

  /** Where we are in the ICE configuration resolution (cached after the first call). */
  async function ensureIce() {
    if (!iceConfig) {
      iceConfig = await iceResolver()
      rebuildSnapshot()
    }
    return iceConfig
  }

  function createPeer(id, { name = null, polite = false } = {}) {
    if (!RTCPeerConnectionImpl) {
      throw new Error('This browser does not support WebRTC (RTCPeerConnection is missing).')
    }
    const pc = new RTCPeerConnectionImpl({
      iceServers: iceConfig?.iceServers ?? [],
      bundlePolicy: 'max-bundle',
    })

    const entry = {
      id,
      name,
      pc,
      polite,
      state: AUDIO_PEER_STATE.CONNECTING,
      muted: false,
      speaking: false,
      makingOffer: false,
      ignoreOffer: false,
      remoteStream: null,
      audioElement: null,
      mediaDetector: null,
      startedAt: now(),
      pendingCandidates: [],
    }
    peers.set(id, entry)

    // Our microphone goes out on every connection (added here, not at offer time, so
    // a peer created by an *incoming* offer also carries audio).
    if (localStream) {
      for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream)
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        // End-of-candidates: relayed as null so the other side can complete ICE.
        transport.ice(id, null)
        return
      }
      transport.ice(id, {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment ?? null,
      })
    }

    pc.ontrack = (event) => {
      // Browsers always send at least one stream with a remote track; if a browser
      // (or a test double) does not, build one around the track — and if even
      // MediaStream is missing, skip the sink rather than throwing in a handler.
      const stream = event.streams?.[0] ?? streamFromTrack(event.track)
      attachRemoteStream(id, stream)
      if (!entry.mediaDetector && createVoiceDetector) {
        entry.mediaDetector = createVoiceDetector(stream, (speaking) => updatePeerSnapshot(id, { speaking }))
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        lastError = null
        updatePeerSnapshot(id, { state: AUDIO_PEER_STATE.CONNECTED, blocked: false })
      }
      else if (state === 'failed') failPeer(id, 'connection failed')
      else if (state === 'closed') updatePeerSnapshot(id, { state: AUDIO_PEER_STATE.CLOSED })
    }

    pc.oniceconnectionstatechange = () => {
      // `disconnected` is often transient; `failed` is not.
      if (pc.iceConnectionState === 'failed') failPeer(id, 'ICE negotiation failed')
    }

    pc.onnegotiationneeded = async () => {
      // Only the impolite side initiates, which is what prevents both peers from
      // offering at the same moment (perfect negotiation).
      if (entry.polite) return
      try {
        entry.makingOffer = true
        // The description is created explicitly rather than relying on the
        // argument-less `setLocalDescription()`: both are valid in browsers, but
        // only the explicit form works in every WebRTC implementation (including
        // the Node one used by scripts/verify-audio.mjs).
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        transport.offer(id, { type: pc.localDescription.type, sdp: pc.localDescription.sdp })
      } catch (error) {
        failPeer(id, `could not create an offer: ${error?.message ?? error}`)
      } finally {
        entry.makingOffer = false
      }
    }

    rebuildSnapshot()
    return entry
  }

  function failPeer(id, reason) {
    const entry = peers.get(id)
    if (!entry) return
    log.warn('audio peer failed', { peerId: id, reason })
    closePeer(id, { state: AUDIO_PEER_STATE.FAILED, reason })
  }

  /** Tear down one peer connection and everything attached to it. */
  function closePeer(id, { state = AUDIO_PEER_STATE.CLOSED, reason = null } = {}) {
    const entry = peers.get(id)
    if (!entry) return false
    entry.mediaDetector?.stop?.()
    entry.mediaDetector = null
    releaseRemoteStream(id)
    try {
      entry.pc.onicecandidate = null
      entry.pc.ontrack = null
      entry.pc.onconnectionstatechange = null
      entry.pc.oniceconnectionstatechange = null
      entry.pc.onnegotiationneeded = null
      entry.pc.close()
    } catch {
      /* already closed */
    }

    if (state === AUDIO_PEER_STATE.CLOSED) {
      peers.delete(id)
      rebuildSnapshot()
    } else {
      updatePeerSnapshot(id, { state, reason, blocked: false })
    }
    return true
  }

  /**
   * A peer we are now authorized to call. Creating the connection starts
   * negotiation through `onnegotiationneeded` on the impolite side; the polite side
   * waits for the offer.
   */
  async function addPeer(id, { name = null } = {}) {
    if (!enabled) return null
    const existing = peers.get(id)
    if (existing) {
      // Never build a second connection for the same peer: that is the duplicate
      // peer connection this whole module exists to prevent.
      if (name && existing.name !== name) updatePeerSnapshot(id, { name })
      return existing
    }
    if (peers.size >= LIMITS.AUDIO_MAX_PEERS) {
      log.warn('refusing to add another audio peer', { peers: peers.size, limit: LIMITS.AUDIO_MAX_PEERS })
      return null
    }

    await ensureIce()
    // Deterministic roles: the smaller player id keeps its offer (impolite).
    const polite = myId !== null && id < myId
    try {
      return createPeer(id, { name, polite })
    } catch (error) {
      // A browser without WebRTC must degrade to a message, not an exception in
      // whichever event handler happened to run first.
      lastError = error?.message ?? 'WebRTC is unavailable in this browser.'
      log.warn('could not create a peer connection', { peerId: id, reason: error?.name })
      rebuildSnapshot()
      return null
    }
  }

  let myId = null
  /**
   * The server's last word on each peer's microphone/eligibility, kept separately
   * from live connections: "who is available" and "who am I connected to" are
   * different questions, and the UI shows both.
   */
  const knownPeers = new Map()

  // -------------------------------------------------------------- signals ---

  async function onRemoteDescription(id, description, { fromName = null } = {}) {
    const entry = peers.get(id) ?? (await addPeer(id, { name: fromName }))
    if (!entry) return
    const pc = entry.pc

    const offerCollision = description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable')
    entry.ignoreOffer = !entry.polite && offerCollision
    if (entry.ignoreOffer) {
      // We are the impolite peer and our own offer is already in flight: dropping the
      // incoming one is the documented resolution, not an error.
      log.debug('ignoring a colliding offer (impolite peer)', { peerId: id })
      return
    }

    try {
      if (offerCollision && entry.polite) {
        // Roll back our offer and accept theirs.
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {})
      }
      await pc.setRemoteDescription(description)
      // Candidates that arrived before the description are applied now.
      for (const candidate of entry.pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => {})
      }
      if (description.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        transport.answer(id, { type: pc.localDescription.type, sdp: pc.localDescription.sdp })
      }
    } catch (error) {
      failPeer(id, `could not apply a ${description.type}: ${error?.message ?? error}`)
    }
  }

  async function onRemoteIce(id, candidate) {
    const entry = peers.get(id)
    if (!entry) return // no session with them: nothing to attach this to
    if (candidate === null) {
      // End-of-candidates: only meaningful once a description exists.
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(null).catch(() => {})
      return
    }
    // A candidate can legitimately arrive before the offer/answer that carries the
    // m-line it belongs to; hold it until the description lands.
    if (!entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate)
      return
    }
    try {
      await entry.pc.addIceCandidate(candidate)
    } catch (error) {
      // A candidate for a dropped connection is expected noise, not a failure.
      log.debug('ignoring an ICE candidate', { peerId: id, reason: error?.name })
    }
  }

  // ---------------------------------------------------------------- mic ---

  async function startLocalMedia() {
    if (localStream) return localStream
    if (!mediaDevices?.getUserMedia) {
      micState = MIC_STATE.UNAVAILABLE
      micError = 'This browser does not expose getUserMedia, so the microphone cannot be used.'
      rebuildSnapshot()
      return null
    }

    micState = MIC_STATE.REQUESTING
    micError = null
    rebuildSnapshot()

    try {
      localStream = await mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS })
    } catch (error) {
      const state = classifyMicError(error)
      micState = state
      micError = micErrorMessage(state, error)
      enabled = false
      rebuildSnapshot()
      // Deliberately logs the error *name* only: never the device list, never a
      // track label, never anything from the audio itself.
      log.warn('microphone unavailable', { state, name: error?.name })
      return null
    }

    micState = MIC_STATE.ACTIVE
    muted = false
    if (createVoiceDetector) {
      localDetector = createVoiceDetector(localStream, (speaking) => {
        if (localSpeaking === speaking) return
        localSpeaking = speaking
        rebuildSnapshot()
      })
    }
    rebuildSnapshot()
    return localStream
  }

  function stopLocalMedia() {
    localDetector?.stop?.()
    localDetector = null
    localSpeaking = false
    for (const track of localStream?.getTracks?.() ?? []) track.stop()
    localStream = null
    if (micState !== MIC_STATE.DENIED && micState !== MIC_STATE.UNAVAILABLE) micState = MIC_STATE.IDLE
    rebuildSnapshot()
  }

  function applyMute(next) {
    muted = Boolean(next)
    // Muting stops sending audio without telling the other side anything about its
    // content: the track is disabled and the peers are informed of the flag only.
    for (const track of localStream?.getAudioTracks?.() ?? []) track.enabled = !muted
    if (muted) {
      localSpeaking = false
      localDetector?.reset?.()
    }
    rebuildSnapshot()
    if (enabled) transport.announce({ enabled: true, muted })
    return muted
  }

  // ------------------------------------------------------------- public ---

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot() {
      return snapshot
    },

    /** The net layer calls this once, with the socket-backed implementation. */
    setTransport(next) {
      transport = { ...transport, ...next }
    },

    /** The net layer tells us our own player id, so negotiation roles are stable. */
    setSelfId(id) {
      myId = id ?? null
    },

    /**
     * Turn the microphone on. Call this from a user gesture and nowhere else:
     * browsers require it, and asking for a microphone the user did not request is
     * exactly the behaviour this design refuses.
     */
    async enable() {
      const myGeneration = ++generation
      if (enabled && localStream) return snapshot

      const stream = await startLocalMedia()
      if (!stream || myGeneration !== generation) return snapshot

      enabled = true
      rebuildSnapshot()
      transport.announce({ enabled: true, muted })

      // Everyone already authorized: add our track and start negotiating.
      for (const [id] of peers) {
        for (const track of stream.getAudioTracks()) {
          if (!peers.get(id).pc.getSenders().some((sender) => sender.track === track)) {
            peers.get(id).pc.addTrack(track, stream)
          }
        }
      }
      return snapshot
    },

    /** Turn the microphone off and end every call (the user asked for privacy). */
    disable() {
      generation += 1
      for (const id of [...peers.keys()]) {
        transport.close(id, 'hangup')
        closePeer(id)
      }
      enabled = false
      stopLocalMedia()
      rebuildSnapshot()
      transport.announce({ enabled: false, muted: false })
      return snapshot
    },

    toggleMute() {
      return applyMute(!muted)
    },

    setMuted(next) {
      return applyMute(next)
    },

    /**
     * `audio:peer` — the server's view of one peer's microphone.
     *
     * `allowed` is the pair verdict: when true we may (and should) connect. When it
     * goes false for a peer we are already connected to, the call is over — the
     * server says so, and we do not keep a peer connection to somebody we are no
     * longer authorized to reach.
     */
    applyPeer(payload) {
      const id = payload?.peerId
      if (!id) return false
      if (id === myId) {
        // Our own state as the server sees it: useful for the UI to render honestly.
        return true
      }
      knownPeers.set(id, { id, name: payload.name ?? knownPeers.get(id)?.name ?? null, enabled: Boolean(payload.enabled), muted: Boolean(payload.muted), allowed: Boolean(payload.allowed) })
      const entry = peers.get(id)
      if (entry && payload.muted !== undefined && entry.muted !== payload.muted) {
        updatePeerSnapshot(id, { muted: Boolean(payload.muted) })
      }
      if (!payload.allowed && entry) {
        // Out of range / ineligible: revoke locally (notify = false; the server has
        // already told the other side, and echoing would double-signal).
        closePeer(id)
      }
      rebuildSnapshot()
      return true
    },

    /**
     * `audio:status` — the server's lifecycle verdict for a pair.
     *
     * status `ready` + allowed ⇒ connect. Anything with allowed false ⇒ end the call
     * cleanly. This is the only place a client decides to open a peer connection.
     */
    async applyStatus(payload) {
      const id = payload?.peerId
      if (!id) return false
      const known = knownPeers.get(id)

      if (!payload.allowed) {
        const hadPeer = peers.has(id)
        if (hadPeer) closePeer(id, { state: AUDIO_PEER_STATE.CLOSED })
        log.debug('audio pair revoked by the server', { peerId: id, status: payload.status })
        void known
        return hadPeer
      }

      if (!enabled) return false
      await addPeer(id, { name: known?.name ?? null })
      return true
    },

    /** `audio:status { allowed: true }` — we may connect to this peer. */
    async authorize(id, { name = null } = {}) {
      if (!enabled) return null
      const entry = await addPeer(id, { name })
      // The polite side never offers on its own; it waits. The impolite side's
      // negotiationneeded fires as soon as a track is attached.
      if (entry && entry.polite && entry.pc.signalingState === 'stable' && !entry.pc.remoteDescription) return entry
      return entry
    },

    /** `audio:status { allowed: false }` or `signal:close` — end this call. */
    revoke(id, { reason = null, notify = false } = {}) {
      const entry = peers.get(id)
      if (!entry) return false
      if (notify) transport.close(id, reason === 'hangup' ? 'hangup' : 'error')
      return closePeer(id)
    },

    /** `signal:offer` (or any description) from a peer. */
    handleSignal(id, description, meta) {
      return onRemoteDescription(id, description, meta)
    },

    /** `signal:ice` from a peer. */
    handleIce(id, candidate) {
      return onRemoteIce(id, candidate)
    },

    /** Diagnostics for tests and the debug panel. */
    getPeers() {
      return [...peers.values()].map((entry) => ({
        id: entry.id,
        name: entry.name,
        state: entry.state,
        polite: entry.polite,
        speaking: entry.speaking,
        hasRemoteStream: Boolean(entry.remoteStream),
        pendingCandidates: entry.pendingCandidates.length,
      }))
    },

    getLocalStream() {
      return localStream
    },

    /** The server's eligibility view of every peer we know about. */
    getKnownPeers() {
      return [...knownPeers.values()].map((peer) => ({ ...peer }))
    },

    /**
     * The session ended (disconnect, logout): drop every peer connection and media
     * resource, but keep the microphone state so a reconnect can reuse it.
     */
    dropAllSessions() {
      for (const id of [...peers.keys()]) closePeer(id)
      knownPeers.clear()
      rebuildSnapshot()
    },

    isSpeaking() {
      return localSpeaking
    },

    /** Two flags for the renderer: is this peer speaking, and are they muted? */
    voiceFlagsFor(id) {
      return voiceMap.get(id) ?? null
    },

    /**
     * Stamp voice flags onto the renderer's peer objects (in place — the list is
     * reused every frame, so this allocates nothing).
     */
    annotatePeers(list) {
      for (const peer of list ?? []) {
        const flags = voiceMap.get(peer.id)
        if (flags) {
          peer.speaking = flags.speaking
          peer.muted = flags.muted
        } else if (peer.speaking || peer.muted) {
          peer.speaking = false
          peer.muted = false
        }
      }
      return list
    },

    /** Tear everything down (unmount, logout, disconnect). */
    destroy() {
      generation += 1
      knownPeers.clear()
      for (const id of [...peers.keys()]) closePeer(id)
      stopLocalMedia()
      enabled = false
      micState = MIC_STATE.IDLE
      micError = null
      listeners.clear()
      snapshot = INITIAL_SNAPSHOT
    },
  }
}

/** The single engine the app uses (mirrors the presence/socket singletons). */
export const audioEngine = createAudioEngine()
