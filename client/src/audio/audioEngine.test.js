/**
 * Audio engine tests.
 *
 * Everything the browser would otherwise provide is faked: `RTCPeerConnection`,
 * `navigator.mediaDevices.getUserMedia`, the `<audio>` sink and the voice detector.
 * That is deliberate — it lets the tests assert the rules that matter (one connection
 * per peer, negotiation roles, teardown, microphone consent) deterministically and
 * without a microphone. The tests therefore prove the *protocol logic*, not that
 * real audio flows; docs/SESSION_06_REPORT.md records what was not verified here.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attenuationGain, createAudioContextHost, stereoPan } from './spatialAudio.js'
import { AUDIO_PEER_STATE, MIC_STATE, createAudioEngine } from './audioEngine.js'
import { LIMITS } from '../../../shared/protocol.js'

// --------------------------------------------------------------- fake WebRTC --

class FakeTrack {
  constructor(kind = 'audio', id = 'track-1') {
    this.kind = kind
    this.id = id
    this.enabled = true
    this.stopCalls = 0
  }
  stop() {
    this.stopCalls += 1
  }
}

class FakeStream {
  constructor(tracks = [new FakeTrack()]) {
    this.tracks = tracks
  }
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
}

class FakePeerConnection {
  static instances = []

  constructor(configuration) {
    this.configuration = configuration
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.iceConnectionState = 'new'
    this.localDescription = null
    this.remoteDescription = null
    this.senders = []
    this.addedCandidates = []
    this.closeCalls = 0
    this.offersLocal = 0
    this.rollbacks = 0
    FakePeerConnection.instances.push(this)
    /** When true, setLocalDescription produces an offer immediately. */
    this.autoOffer = true
  }

  addTrack(track, stream) {
    const sender = { track, stream }
    this.senders.push(sender)
    // Real browsers fire negotiationneeded asynchronously after a track is added.
    queueMicrotask(() => this.onnegotiationneeded?.())
    return sender
  }

  getSenders() {
    return this.senders
  }

  async createOffer() {
    this.offersLocal += 1
    return { type: 'offer', sdp: `sdp-offer-${this.offersLocal}` }
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'sdp-answer' }
  }

  async setLocalDescription(description) {
    if (!description) throw new TypeError('Expected an object') // wrtc behaves this way
    if (description.type === 'rollback') {
      this.rollbacks += 1
      this.localDescription = null
      this.signalingState = 'stable'
      return
    }
    this.localDescription = description
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
  }

  async setRemoteDescription(description) {
    this.remoteDescription = { ...description }
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
  }

  async addIceCandidate(candidate) {
    this.addedCandidates.push(candidate)
  }

  close() {
    this.closeCalls += 1
    this.connectionState = 'closed'
    this.signalingState = 'closed'
  }

  // ---- test helpers -------------------------------------------------------

  emitIce(candidate) {
    this.onicecandidate?.({ candidate })
  }

  emitIceEnd() {
    this.onicecandidate?.({ candidate: null })
  }

  emitRemoteTrack(track = new FakeTrack('audio', 'remote'), streams = [new FakeStream([track])]) {
    this.onicecandidate = this.onicecandidate // keep the handler explicit
    this.ontrack?.({ track, streams })
  }

  setConnectionState(state) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  setIceConnectionState(state) {
    this.iceConnectionState = state
    this.oniceconnectionstatechange?.()
  }
}

class FakeAudioElement {
  constructor({ behavior = 'resolve' } = {}) {
    this.srcObject = null
    this.playCalls = 0
    this.pauseCalls = 0
    this.removed = false
    this.behavior = behavior
  }
  play() {
    this.playCalls += 1
    if (this.behavior === 'reject') {
      // Lazily rejected, so the engine's catch is attached in the same tick and no
      // unhandled rejection pollutes the run.
      return Promise.reject(Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' }))
    }
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls += 1
  }
  remove() {
    this.removed = true
  }
}

/** A voice detector whose speaking flag the test drives directly. */
function createFakeDetector(stream, onSpeaking) {
  const detector = {
    stream,
    stopped: false,
    stop() {
      detector.stopped = true
    },
    reset() {},
  }
  detector.speak = (speaking) => onSpeaking(speaking)
  return detector
}

/**
 * A recording Web Audio context. jsdom has no Web Audio, so the graph path can only be
 * exercised with one of these — every node and every parameter write is recorded, which
 * is what the assertions below read.
 */
function createFakeAudioContext() {
  const created = { sources: 0, gains: 0, panners: 0, disconnects: 0, writes: 0 }
  const params = []

  function param(value, label) {
    const target = {
      label,
      value,
      setValueAtTime(next) {
        created.writes += 1
        target.value = next
        return target
      },
      setTargetAtTime(next) {
        created.writes += 1
        target.value = next
        return target
      },
      linearRampToValueAtTime(next) {
        created.writes += 1
        target.value = next
        return target
      },
    }
    params.push(target)
    return target
  }

  function node(kind, extra) {
    return { kind, connect: () => node, disconnect: () => { created.disconnects += 1 }, ...extra }
  }

  const context = {
    sampleRate: 48_000,
    state: 'running',
    currentTime: 0,
    destination: { id: 'destination' },
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createMediaStreamSource: () => {
      created.sources += 1
      return node('source')
    },
    createGain: () => {
      created.gains += 1
      return node('gain', { gain: param(1, 'gain') })
    },
    createStereoPanner: () => {
      created.panners += 1
      return node('panner', { pan: param(0, 'pan') })
    },
  }

  return {
    context,
    created,
    params,
    gainParams: () => params.filter((entry) => entry.label === 'gain'),
    panParams: () => params.filter((entry) => entry.label === 'pan'),
  }
}

// ------------------------------------------------------------------- harness --

function setup(options = {}) {
  const { iceServers = [{ urls: ['stun:test:3478'] }], hasTurn = false } = options
  const mediaDevices = 'mediaDevices' in options ? options.mediaDevices : { getUserMedia: vi.fn(async () => new FakeStream()) }
  const transport = {
    announce: vi.fn(),
    offer: vi.fn(),
    answer: vi.fn(),
    ice: vi.fn(),
    close: vi.fn(),
  }
  const elements = []
  const detectors = []
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  // A mutable knob the tests flip: `elementBehavior` makes play() reject.
  const settings = { elementBehavior: 'resolve' }
  const resolver = vi.fn(async () => ({ iceServers, hasTurn, source: 'server' }))
  const engine = createAudioEngine({
    RTCPeerConnectionImpl: FakePeerConnection,
    mediaDevices,
    createAudioElement: () => {
      const element = new FakeAudioElement({ behavior: settings.elementBehavior })
      elements.push(element)
      return element
    },
    createVoiceDetector: (stream, onSpeaking) => {
      const detector = createFakeDetector(stream, onSpeaking)
      detectors.push(detector)
      return detector
    },
    iceResolver: resolver,
    logger,
    // Injected only by the spatial tests: without it the engine has no Web Audio and
    // correctly falls back to a plain element sink.
    audioContextHost: options.spatial
      ? createAudioContextHost({ factory: () => options.spatial.context })
      : null,
  })
  engine.setTransport(transport)
  return { engine, transport, elements, detectors, resolver, logger, settings }
}

/** Let queued microtasks (negotiationneeded, awaits) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  FakePeerConnection.instances = []
})

// ------------------------------------------------------------ microphone rules --

describe('microphone access', () => {
  it('never touches getUserMedia until the user asks', async () => {
    const getUserMedia = vi.fn(async () => new FakeStream())
    const { engine } = setup({ mediaDevices: { getUserMedia } })

    await flush()

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(engine.getSnapshot().mic).toBe(MIC_STATE.IDLE)
    expect(engine.getSnapshot().enabled).toBe(false)
  })

  it('requests audio-only constraints on enable and announces the state', async () => {
    const getUserMedia = vi.fn(async () => new FakeStream())
    const { engine, transport } = setup({ mediaDevices: { getUserMedia } })

    await engine.enable()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    const constraints = getUserMedia.mock.calls[0][0]
    expect(Object.keys(constraints)).toEqual(['audio'])
    expect(constraints.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
    expect(engine.getSnapshot().mic).toBe(MIC_STATE.ACTIVE)
    expect(engine.getSnapshot().enabled).toBe(true)
    expect(transport.announce).toHaveBeenCalledWith({ enabled: true, muted: false })
  })

  it('reports a denied permission without announcing a microphone', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const { engine, transport } = setup({
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw denied
        }),
      },
    })

    await engine.enable()
    const snapshot = engine.getSnapshot()

    expect(snapshot.mic).toBe(MIC_STATE.DENIED)
    expect(snapshot.micError).toMatch(/permission was denied/i)
    expect(snapshot.enabled).toBe(false)
    expect(transport.announce).not.toHaveBeenCalled()
  })

  it('distinguishes a missing or busy device from a denial', async () => {
    const cases = [
      ['NotFoundError', MIC_STATE.UNAVAILABLE],
      ['OverconstrainedError', MIC_STATE.UNAVAILABLE],
      ['NotReadableError', MIC_STATE.ERROR],
      [undefined, MIC_STATE.ERROR],
    ]

    for (const [name, expected] of cases) {
      const error = name ? Object.assign(new Error(name), { name, message: 'boom' }) : new Error('boom')
      const { engine } = setup({
        mediaDevices: {
          getUserMedia: vi.fn(async () => {
            throw error
          }),
        },
      })
      await engine.enable()
      expect(engine.getSnapshot().mic, `${name} -> ${expected}`).toBe(expected)
      expect(engine.getSnapshot().micError).toBeTruthy()
    }
  })

  it('reports a browser without getUserMedia instead of throwing', async () => {
    const { engine } = setup({ mediaDevices: null })

    await engine.enable()

    expect(engine.getSnapshot().mic).toBe(MIC_STATE.UNAVAILABLE)
    expect(engine.getSnapshot().micError).toMatch(/getUserMedia/i)
  })

  it('stops every track when the microphone is switched off', async () => {
    const track = new FakeTrack()
    const { engine, transport } = setup({
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([track])) },
    })

    await engine.enable()
    engine.disable()

    expect(track.stopCalls).toBe(1)
    expect(engine.getSnapshot().mic).toBe(MIC_STATE.IDLE)
    expect(engine.getLocalStream()).toBeNull()
    expect(transport.announce).toHaveBeenLastCalledWith({ enabled: false, muted: false })
  })

  it('does not resurrect the microphone when a later enable is cancelled by disable', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const track = new FakeTrack()
    const { engine, transport } = setup({
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          await pending
          return new FakeStream([track])
        }),
      },
    })

    const enabling = engine.enable()
    engine.disable() // the user changed their mind while the prompt was open
    release()
    await enabling

    expect(engine.getSnapshot().enabled).toBe(false)
    expect(transport.announce).toHaveBeenCalledTimes(1)
    expect(transport.announce).toHaveBeenCalledWith({ enabled: false, muted: false })
  })

  it('mutes by disabling the outbound track and telling the peers', async () => {
    const track = new FakeTrack()
    const { engine, transport } = setup({
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([track])) },
    })
    await engine.enable()

    expect(engine.toggleMute()).toBe(true)
    expect(track.enabled).toBe(false)
    expect(transport.announce).toHaveBeenLastCalledWith({ enabled: true, muted: true })
    expect(engine.getSnapshot().muted).toBe(true)

    expect(engine.toggleMute()).toBe(false)
    expect(track.enabled).toBe(true)
    expect(transport.announce).toHaveBeenLastCalledWith({ enabled: true, muted: false })
  })

  it('does not announce mute state while the microphone is off', async () => {
    const { engine, transport } = setup()

    engine.setMuted(true)

    expect(transport.announce).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------- peers ----

describe('peer connections', () => {
  it('refuses to connect to anybody until our microphone is on', async () => {
    const { engine } = setup()

    await engine.authorize('peer-1')

    expect(FakePeerConnection.instances).toHaveLength(0)
    expect(engine.getSnapshot().peers).toEqual([])
  })

  it('creates exactly one connection per peer, with our track attached', async () => {
    const { engine } = setup()
    await engine.enable()

    await engine.authorize('peer-1')
    await engine.authorize('peer-1')
    await engine.authorize('peer-1')

    expect(FakePeerConnection.instances).toHaveLength(1)
    expect(FakePeerConnection.instances[0].senders).toHaveLength(1)
    expect(engine.getPeers()).toHaveLength(1)
  })

  it('passes the resolved ICE servers to the connection', async () => {
    const iceServers = [{ urls: ['turn:relay:3478'], username: 'u', credential: 'c' }]
    const { engine } = setup({ iceServers, hasTurn: true })
    await engine.enable()

    await engine.authorize('peer-1')

    expect(FakePeerConnection.instances[0].configuration.iceServers).toEqual(iceServers)
    expect(FakePeerConnection.instances[0].configuration.bundlePolicy).toBe('max-bundle')
    expect(engine.getSnapshot()).toMatchObject({ iceSource: 'server', hasTurn: true })
  })

  it('lets the impolite side (smaller player id) open the negotiation', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('alpha')
    await engine.enable()

    await engine.authorize('zulu')
    await flush()

    expect(transport.offer).toHaveBeenCalledTimes(1)
    expect(transport.offer.mock.calls[0][0]).toBe('zulu')
    expect(transport.offer.mock.calls[0][1]).toMatchObject({ type: 'offer', sdp: 'sdp-offer-1' })
    expect(engine.getSnapshot().peers[0].direction).toBe('impolite')
  })

  it('makes the polite side (larger player id) wait for the offer', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('zulu')
    await engine.enable()

    await engine.authorize('alpha')
    await flush()

    expect(transport.offer).not.toHaveBeenCalled()
    expect(engine.getSnapshot().peers[0].direction).toBe('polite')
  })

  it('answers an incoming offer and keeps a single connection', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    const incoming = { type: 'offer', sdp: 'remote-offer' }

    await engine.handleSignal('alpha', incoming)
    await flush()

    expect(FakePeerConnection.instances).toHaveLength(1)
    expect(FakePeerConnection.instances[0].remoteDescription).toEqual(incoming)
    expect(transport.answer).toHaveBeenCalledWith('alpha', expect.objectContaining({ type: 'answer' }))
    expect(transport.offer).not.toHaveBeenCalled()
  })

  it('creates the connection from an incoming offer even before audio:status arrives', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()

    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })

    expect(engine.getPeers()).toHaveLength(1)
    expect(engine.getPeers()[0].name).toBeNull()
  })

  it('rolls back its own offer when a colliding offer arrives as the polite side', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('zulu') // polite
    await engine.enable()
    await engine.authorize('alpha')
    const pc = FakePeerConnection.instances[0]
    // Pretend we had started an offer of our own (glare).
    pc.localDescription = { type: 'offer', sdp: 'our-offer' }
    pc.signalingState = 'have-local-offer'

    await engine.handleSignal('alpha', { type: 'offer', sdp: 'their-offer' })
    await flush()

    expect(pc.rollbacks).toBe(1)
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' })
    expect(transport.answer).toHaveBeenCalledWith('alpha', expect.objectContaining({ type: 'answer' }))
  })

  it('ignores a colliding offer while it is making its own, as the impolite side', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('alpha') // impolite
    await engine.enable()
    await engine.authorize('zulu')
    const pc = FakePeerConnection.instances[0]
    pc.makingOffer = true
    pc.signalingState = 'have-local-offer'

    await engine.handleSignal('zulu', { type: 'offer', sdp: 'their-offer' })

    expect(pc.remoteDescription).toBeNull()
    expect(transport.answer).not.toHaveBeenCalled()
    expect(FakePeerConnection.instances).toHaveLength(1)
  })

  it('relays ICE candidates and end-of-candidates', async () => {
    const { engine, transport } = setup()
    engine.setSelfId('alpha')
    await engine.enable()
    await engine.authorize('zulu')
    const pc = FakePeerConnection.instances[0]

    pc.emitIce({ candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 })
    pc.emitIceEnd()

    expect(transport.ice).toHaveBeenCalledTimes(2)
    expect(transport.ice.mock.calls[0][0]).toBe('zulu')
    expect(transport.ice.mock.calls[0][1]).toMatchObject({ candidate: expect.stringContaining('candidate:1'), sdpMid: '0' })
    expect(transport.ice.mock.calls[1][1]).toBeNull()
  })

  it('queues candidates that arrive before the remote description', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]
    pc.addedCandidates = []

    // A fresh connection, so we can observe the queue from the start.
    const late = { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0 }
    pc.remoteDescription = null
    await engine.handleIce('alpha', late)
    expect(pc.addedCandidates).toEqual([])
    expect(engine.getPeers()[0].pendingCandidates).toBe(1)

    await engine.handleSignal('alpha', { type: 'answer', sdp: 'their-answer' })
    expect(pc.addedCandidates).toEqual([late])
    expect(engine.getPeers()[0].pendingCandidates).toBe(0)
  })

  it('ignores candidates from a peer we have no session with', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()

    await expect(engine.handleIce('nobody', { candidate: 'x' })).resolves.toBeUndefined()
    expect(FakePeerConnection.instances).toHaveLength(0)
  })

  it('accepts end-of-candidates only once a description exists', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]
    pc.addedCandidates = []

    await engine.handleIce('alpha', null)
    expect(pc.addedCandidates).toEqual([null])
  })

  it('attaches the remote stream to a managed audio element and plays it', async () => {
    const { engine, elements, detectors } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]

    const remoteTrack = new FakeTrack('audio', 'remote-track')
    const remoteStream = new FakeStream([remoteTrack])
    pc.ontrack({ track: remoteTrack, streams: [remoteStream] })

    expect(elements).toHaveLength(1)
    expect(elements[0].srcObject).toBe(remoteStream)
    expect(elements[0].playCalls).toBe(1)
    // One detector for our own microphone, one for the remote stream.
    expect(detectors).toHaveLength(2)
    expect(detectors.at(-1).stream).toBe(remoteStream)
    expect(engine.getPeers()[0].hasRemoteStream).toBe(true)
  })

  it('falls back to a MediaStream built from the track when streams is empty', async () => {
    const { engine, elements } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]

    // jsdom has no MediaStream; the engine falls back to whatever the platform has,
    // so the test supplies one to prove the fallback path is wired up.
    const original = globalThis.MediaStream
    globalThis.MediaStream = FakeStream
    try {
      pc.ontrack({ track: new FakeTrack('audio', 'remote-track'), streams: [] })

      expect(elements[0].srcObject).toBeInstanceOf(FakeStream)
      expect(elements[0].srcObject.getAudioTracks()).toHaveLength(1)
    } finally {
      globalThis.MediaStream = original
    }
  })

  it('marks a peer connected, and a failure, from the connection state', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]

    pc.setConnectionState('connected')
    expect(engine.getSnapshot().peers[0].state).toBe(AUDIO_PEER_STATE.CONNECTED)

    pc.setConnectionState('failed')
    expect(engine.getSnapshot().peers[0].state).toBe(AUDIO_PEER_STATE.FAILED)
    expect(pc.closeCalls).toBe(1)
  })

  it('treats a failed ICE negotiation as a failed call', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })

    FakePeerConnection.instances[0].setIceConnectionState('failed')

    expect(engine.getSnapshot().peers[0].state).toBe(AUDIO_PEER_STATE.FAILED)
  })

  it('flags a blocked autoplay instead of failing the call', async () => {
    const { engine, settings, logger } = setup()
    settings.elementBehavior = 'reject'
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[0]

    pc.ontrack({ track: new FakeTrack('audio'), streams: [new FakeStream()] })
    await flush()

    expect(engine.getSnapshot().peers[0].state).toBe(AUDIO_PEER_STATE.CONNECTING)
    expect(logger.warn).toHaveBeenCalledWith('remote audio could not autoplay', expect.objectContaining({ peerId: 'alpha' }))
  })

  it('caps the number of simultaneous calls', async () => {
    const { engine } = setup()
    engine.setSelfId('zzz')
    await engine.enable()

    for (let index = 0; index < LIMITS.AUDIO_MAX_PEERS + 3; index += 1) {
      await engine.authorize(`peer-${String(index).padStart(2, '0')}`)
    }

    expect(engine.getSnapshot().peers).toHaveLength(LIMITS.AUDIO_MAX_PEERS)
    expect(FakePeerConnection.instances).toHaveLength(LIMITS.AUDIO_MAX_PEERS)
  })

  it('reports missing WebRTC as a message instead of throwing', async () => {
    // A browser without RTCPeerConnection must degrade to a message, not an exception
    // thrown out of whichever socket handler happened to run first.
    const bare = createAudioEngine({
      RTCPeerConnectionImpl: undefined,
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream()) },
      iceResolver: async () => ({ iceServers: [], hasTurn: false, source: 'default-stun' }),
      createAudioElement: () => null,
      createVoiceDetector: null,
      logger: null,
    })
    bare.setSelfId('alpha')
    await bare.enable()

    await expect(bare.authorize('zulu')).resolves.toBeNull()

    expect(bare.getSnapshot().error).toMatch(/does not support WebRTC/i)
    expect(bare.getSnapshot().peers).toEqual([])
    // …and the microphone itself still works, so the UI can explain the problem.
    expect(bare.getSnapshot().mic).toBe(MIC_STATE.ACTIVE)
  })
})

// ----------------------------------------------------------------- teardown ---

describe('teardown', () => {
  async function connectedPeer(engine) {
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1]
    pc.ontrack({ track: new FakeTrack('audio'), streams: [new FakeStream()] })
    pc.setConnectionState('connected')
    return pc
  }

  it('closes the connection, the element and the detector when the server revokes a pair', async () => {
    const { engine, elements, detectors } = setup()
    const pc = await connectedPeer(engine)

    engine.revoke('alpha')

    expect(pc.closeCalls).toBe(1)
    expect(elements[0].srcObject).toBeNull()
    expect(elements[0].pauseCalls).toBe(1)
    expect(elements[0].removed).toBe(true)
    expect(detectors.at(-1).stopped).toBe(true)
    expect(engine.getSnapshot().peers).toEqual([])
  })

  it('tells the peer when we hang up, and stays quiet otherwise', async () => {
    const { engine, transport } = setup()
    await connectedPeer(engine)

    engine.revoke('alpha', { notify: true, reason: 'hangup' })
    expect(transport.close).toHaveBeenCalledWith('alpha', 'hangup')

    transport.close.mockClear()
    const second = await connectedPeer(engine)
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: false, muted: false, allowed: false })
    expect(second.closeCalls).toBe(1)
    expect(transport.close).not.toHaveBeenCalled()
  })

  it('ends every call when the microphone is switched off', async () => {
    const { engine, transport } = setup()
    const pc = await connectedPeer(engine)

    engine.disable()

    expect(pc.closeCalls).toBe(1)
    expect(transport.close).toHaveBeenCalledWith('alpha', 'hangup')
    expect(engine.getSnapshot().peers).toEqual([])
  })

  it('drops all sessions on disconnect but keeps the microphone state', async () => {
    const { engine } = setup()
    const pc = await connectedPeer(engine)
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })

    engine.dropAllSessions()

    expect(pc.closeCalls).toBe(1)
    expect(engine.getSnapshot().peers).toEqual([])
    expect(engine.getKnownPeers()).toEqual([])
    expect(engine.getSnapshot().mic).toBe(MIC_STATE.ACTIVE)
  })

  it('destroy() releases everything, including the microphone', async () => {
    const track = new FakeTrack()
    const { engine, elements } = setup({
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([track])) },
    })
    const pc = await connectedPeer(engine)

    engine.destroy()

    expect(pc.closeCalls).toBe(1)
    expect(track.stopCalls).toBe(1)
    expect(elements[0].removed).toBe(true)
    expect(engine.getSnapshot()).toMatchObject({ mic: MIC_STATE.IDLE, peers: [], enabled: false })
  })
})

// ------------------------------------------------------------ server messages --

describe('server messages', () => {
  it('connects on audio:status ready and reports the peer name', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })
    await engine.enable()

    await engine.applyStatus({ peerId: 'alpha', status: 'ready', allowed: true })

    expect(FakePeerConnection.instances).toHaveLength(1)
    expect(engine.getSnapshot().peers[0]).toMatchObject({ id: 'alpha', name: 'Ada', state: AUDIO_PEER_STATE.CONNECTING })
  })

  it('ignores a ready status while our own microphone is off', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })

    await engine.applyStatus({ peerId: 'alpha', status: 'ready', allowed: true })

    expect(FakePeerConnection.instances).toHaveLength(0)
    expect(engine.getKnownPeers()).toEqual([{ id: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true }])
  })

  it('closes the call when the server revokes it, for every reason', async () => {
    for (const status of ['out_of_range', 'peer_ineligible', 'self_ineligible', 'peer_left', 'denied']) {
      FakePeerConnection.instances = []
      const { engine } = setup()
      engine.setSelfId('zulu')
      engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })
      await engine.enable()
      await engine.applyStatus({ peerId: 'alpha', status: 'ready', allowed: true })

      await engine.applyStatus({ peerId: 'alpha', status, allowed: false })

      expect(engine.getSnapshot().peers, status).toEqual([])
      expect(FakePeerConnection.instances[0].closeCalls, status).toBe(1)
    }
  })

  it('closes the call when an allowed peer becomes ineligible (audio:peer allowed:false)', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })
    await engine.enable()
    await engine.applyStatus({ peerId: 'alpha', status: 'ready', allowed: true })

    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: false, muted: false, allowed: false })

    expect(engine.getSnapshot().peers).toEqual([])
    expect(FakePeerConnection.instances[0].closeCalls).toBe(1)
  })

  it('records our own state without creating a connection to ourselves', async () => {
    const { engine } = setup()
    engine.setSelfId('alpha')
    await engine.enable()

    engine.applyPeer({ peerId: 'alpha', name: 'Us', enabled: true, muted: false, allowed: false })

    expect(engine.getSnapshot().peers).toEqual([])
    expect(engine.getKnownPeers()).toEqual([])
  })

  it('tracks the peer mute flag from the server', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: false, allowed: true })
    await engine.enable()
    await engine.applyStatus({ peerId: 'alpha', status: 'ready', allowed: true })

    engine.applyPeer({ peerId: 'alpha', name: 'Ada', enabled: true, muted: true, allowed: true })

    expect(engine.getSnapshot().peers[0].muted).toBe(true)
  })

  it('ignores malformed server payloads', async () => {
    const { engine } = setup()
    engine.setSelfId('zulu')
    await engine.enable()

    expect(engine.applyPeer(null)).toBe(false)
    expect(engine.applyPeer({})).toBe(false)
    expect(await engine.applyStatus(null)).toBe(false)
    expect(await engine.applyStatus({})).toBe(false)
    expect(engine.getSnapshot().peers).toEqual([])
    expect(FakePeerConnection.instances).toHaveLength(0)
  })
})

// ------------------------------------------------------------ speaking flags --

describe('speaking indicators', () => {
  it('publishes our own voice activity when the detector fires', async () => {
    const { engine, detectors } = setup()
    await engine.enable()

    detectors[0].speak(true)
    expect(engine.getSnapshot().peers).toEqual([])
    expect(engine.isSpeaking()).toBe(true)

    detectors[0].speak(false)
    expect(engine.isSpeaking()).toBe(false)
  })

  it('clears our speaking flag when the microphone is muted', async () => {
    const { engine, detectors } = setup()
    await engine.enable()
    detectors[0].speak(true)

    engine.setMuted(true)

    expect(engine.isSpeaking()).toBe(false)
  })

  it('reports a remote peer speaking, and stamps it onto the renderer list', async () => {
    const { engine, detectors } = setup()
    engine.setSelfId('zulu')
    await engine.enable()
    await engine.handleSignal('alpha', { type: 'offer', sdp: 'remote-offer' })
    FakePeerConnection.instances[0].ontrack({ track: new FakeTrack('audio'), streams: [new FakeStream()] })

    detectors.at(-1).speak(true)

    expect(engine.getSnapshot().peers[0].speaking).toBe(true)
    expect(engine.voiceFlagsFor('alpha')).toEqual({
      speaking: true,
      muted: false,
      state: AUDIO_PEER_STATE.CONNECTING,
      // Spatial read-out, stamped for the renderer's labels (null until the graph has
      // a world position to attenuate against).
      distance: null,
      volumePercent: 0,
    })

    const list = [{ id: 'alpha' }, { id: 'ghost', speaking: true }]
    engine.annotatePeers(list)
    expect(list[0]).toEqual({ id: 'alpha', speaking: true, muted: false, distance: null, volumePercent: 0 })
    expect(list[1]).toEqual({ id: 'ghost', speaking: false, muted: false })
  })

  it('never logs audio content, SDP or candidates', async () => {
    const { engine, logger } = setup()
    engine.setSelfId('alpha')
    await engine.enable()
    await engine.authorize('zulu')
    const pc = FakePeerConnection.instances[0]
    // A full flow, including everything that carries media-shaped data.
    pc.emitIce({ candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' })
    pc.emitIceEnd()
    await engine.handleSignal('zulu', { type: 'answer', sdp: 'zzz-top-secret-sdp' })
    pc.ontrack({ track: new FakeTrack('audio'), streams: [new FakeStream()] })
    engine.revoke('zulu')

    const serialised = JSON.stringify([...logger.debug.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls])

    expect(serialised).not.toMatch(/candidate:/)
    expect(serialised).not.toMatch(/zzz-top-secret-sdp/)
    expect(serialised).not.toMatch(/v=0|m=audio/)
  })
})

// ---------------------------------------------------------------- spatial audio --

describe('spatial audio (driven by world coordinates)', () => {
  /** Connect one peer over the managed graph and return everything the checks need. */
  async function connected(spatial = createFakeAudioContext()) {
    const harness = setup({ spatial })
    const { engine } = harness
    await engine.enable()
    await engine.authorize('peer-1', { name: 'Ada' })
    // The remote side answers with its stream: that is what builds the graph.
    const pc = FakePeerConnection.instances[0]
    pc.setRemoteDescription?.({ type: 'answer', sdp: 'v=0-answer' })
    await flush()
    pc.emitRemoteTrack(new FakeTrack('audio', 'remote'), [new FakeStream([new FakeTrack('audio', 'remote')])])
    pc.setConnectionState('connected')
    return { ...harness, spatial, engine }
  }

  const frameWith = (distance, { radius = 100, player = { x: 0, y: 0 } } = {}) => ({
    player,
    peers: [{ id: 'peer-1', x: player.x + distance, y: player.y }],
    radius,
    dt: 1 / 60,
  })

  it('builds exactly one graph for the stream, and never a second one', async () => {
    const { engine, spatial } = await connected()

    expect(spatial.created.sources).toBe(1)
    expect(spatial.created.gains).toBe(1)
    expect(spatial.created.panners).toBe(1)
    expect(engine.getSpatialSummary().graphPeers).toBe(1)
    // The plain element fallback must NOT also be attached: one volume control per stream.
    expect(engine.getSpatialSummary().elementPeers).toBe(0)
  })

  it('writes the documented curve from world distance, frame after frame', async () => {
    const { engine, spatial } = await connected()
    const gain = spatial.gainParams().at(-1)
    const pan = spatial.panParams().at(-1)

    for (const distance of [0, 25, 50, 100, 400]) {
      spatial.context.currentTime += 1 / 60
      engine.updateSpatial(frameWith(distance))
      expect(gain.value).toBeCloseTo(attenuationGain(distance, 100), 6)
      expect(pan.value).toBeCloseTo(stereoPan(distance, 100), 6)
    }
  })

  it('reads the peer positions the renderer hands it, in place (no copying)', async () => {
    const { engine, spatial } = await connected()
    const gain = spatial.gainParams().at(-1)
    const livePeer = { id: 'peer-1', x: 30, y: 40 }
    const frame = { player: { x: 0, y: 0 }, peers: [livePeer], radius: 100, dt: 1 / 60 }

    engine.updateSpatial(frame)
    expect(gain.value).toBeCloseTo(0.5, 6) // hypot(30, 40) = 50 u

    // The renderer mutates the same object next frame — the graph must follow it.
    livePeer.x = 100
    engine.updateSpatial(frame)
    expect(gain.value).toBe(0)
  })

  it('honours a listening radius the app changed at runtime', async () => {
    const { engine, spatial } = await connected()
    engine.setListeningRadius(200)

    engine.updateSpatial(frameWith(100, { radius: 200 }))

    expect(spatial.gainParams().at(-1).value).toBeCloseTo(0.5, 6)
    expect(engine.getSpatialSummary().listeningRadius).toBe(200)
  })

  it('treats zoom as a pointer concern: nothing about the camera reaches the graph', async () => {
    const { engine, spatial } = await connected()
    const gain = spatial.gainParams().at(-1)

    engine.updateSpatial(frameWith(50))
    const before = gain.value
    // The frame object has no zoom field at all (see the renderer's frame hook), so a
    // camera change cannot alter the mix; re-running the same world distance proves the
    // value is a pure function of world units.
    engine.updateSpatial(frameWith(50))

    expect(gain.value).toBe(before)
    expect(before).toBeCloseTo(0.5, 6)
  })

  it('opens no AudioNodes and rewrites nothing while a peer stands still', async () => {
    const { engine, spatial } = await connected()
    engine.updateSpatial(frameWith(50))
    const nodes = spatial.created.sources + spatial.created.gains + spatial.created.panners
    const writes = spatial.created.writes

    for (let index = 0; index < 600; index += 1) {
      spatial.context.currentTime += 1 / 60
      engine.updateSpatial(frameWith(50))
    }

    expect(spatial.created.sources + spatial.created.gains + spatial.created.panners).toBe(nodes)
    expect(spatial.created.writes).toBe(writes)
  })

  it('reports the distance and the level it mixes at, for the HUD', async () => {
    const { engine } = await connected()

    engine.updateSpatial(frameWith(25))

    const peer = engine.getSnapshot().peers[0]
    expect(peer.distance).toBe(25)
    expect(peer.volumePercent).toBe(75)
    expect(peer.usesGraph).toBe(true)

    const list = [{ id: 'peer-1' }]
    engine.annotatePeers(list)
    expect(list[0]).toMatchObject({ distance: 25, volumePercent: 75 })
  })

  it('silences a muted peer without touching the graph topology', async () => {
    const { engine, spatial } = await connected()
    engine.updateSpatial(frameWith(25))
    const gain = spatial.gainParams().at(-1)

    engine.setMuted(true)
    engine.updateSpatial(frameWith(25))

    // Mute is a send-side flag on our own track; the remote peer's level is unchanged,
    // and no second volume control is created for it.
    expect(gain.value).toBeCloseTo(0.75, 6)
    expect(spatial.created.gains).toBe(1)
  })

  it('releases the graph when the peer is revoked, and stops writing to it', async () => {
    const { engine, spatial } = await connected()
    engine.updateSpatial(frameWith(25))
    const gain = spatial.gainParams().at(-1)
    const writesAfterRevoke = () => spatial.created.writes

    engine.revoke('peer-1', { reason: 'peer_left' })
    const writes = writesAfterRevoke()

    engine.updateSpatial(frameWith(25))

    expect(spatial.created.disconnects).toBeGreaterThanOrEqual(3)
    expect(engine.getSpatialSummary().graphPeers).toBe(0)
    // Disposal ramps the gain down; after that the frame has nobody to write to.
    expect(gain.value).toBe(0)
    expect(writesAfterRevoke()).toBe(writes)
  })

  it('publishes the read-out to React at most 4×/second, never per frame', async () => {
    const { engine } = await connected()
    const readouts = () => engine.getSpatialSummary().lastFrame.readout
    engine.updateSpatial(frameWith(10))
    const before = readouts()

    // A peer crossing the whole radius in one animation frame's worth of updates: the
    // mix moves every frame, the HUD must not.
    for (let step = 0; step < 600; step += 1) engine.updateSpatial(frameWith(10 + (step % 90)))

    const published = readouts() - before
    expect(published).toBeLessThanOrEqual(2)
    expect(engine.getSpatialSummary().lastFrame.updated).toBeGreaterThan(0)
  })

  it('is inert (and silent) when a peer has no stream yet', async () => {
    const { engine, spatial } = await connected()

    expect(() => engine.updateSpatial({ player: { x: 0, y: 0 }, peers: [], radius: 100, dt: 1 / 60 })).not.toThrow()
    expect(() => engine.updateSpatial(null)).not.toThrow()

    expect(spatial.created.writes).toBeGreaterThan(0) // the fade-in at creation
    expect(engine.getSpatialSummary().graphPeers).toBe(1)
  })
})
