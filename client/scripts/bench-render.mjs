#!/usr/bin/env node
/**
 * Render + spatial-audio benchmark — what this actually measures, stated up front.
 *
 *   1. The REAL frame loop: `render/engine.js` with the real scene, furniture and
 *      avatar renderers, driven with a recording 2D context (client/src/test/fakeCanvas.js)
 *      at increasing avatar counts. This is genuine CPU cost on this machine, but it
 *      is NOT browser frame time: there is no rasteriser, no GPU, no compositor, and
 *      the recording context is not a browser's canvas implementation. Read the
 *      numbers as "what our JavaScript costs per frame", not "fps in Chrome".
 *   2. The per-stream spatial path: for every remote stream, distance → attenuation →
 *      pan → AudioParam automation, through the real `spatialAudio.js` against a fake
 *      Web Audio graph. This measures our math and parameter writes; a real
 *      AudioContext does the mixing on its own thread and its cost is not measurable
 *      here (and is not ours to claim).
 *
 * It also counts canvas operations per frame and AudioNodes created in total, which
 * is the honest way to support the "no per-frame allocation, no new AudioNodes per
 * frame" requirements: those are structural claims, and they are counted, not timed.
 *
 * Usage:
 *   node client/scripts/bench-render.mjs [--avatars 1,4,8,16,32] [--frames 600]
 *                                        [--warmup 120] [--heap] [--json out.json]
 *   node --expose-gc client/scripts/bench-render.mjs --heap    (reliable heap numbers)
 */

import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { JSDOM } from 'jsdom'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const hasFlag = (name) => args.includes(`--${name}`)

const AVATAR_COUNTS = String(readArg('avatars', '1,4,8,16,32,48'))
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
const FRAMES = Number(readArg('frames', 600))
const WARMUP = Number(readArg('warmup', 120))
const WANT_HEAP = hasFlag('heap')
const JSON_OUT = readArg('json', null)

// ------------------------------------------------------------- jsdom setup ---
//
// The engine is browser code: it wants a canvas, a container with a measured box,
// requestAnimationFrame and performance. jsdom supplies the DOM, we supply a
// deterministic frame clock so timing measures work and not the timer.

const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>')
const { window } = dom

globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.Event = window.Event
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.devicePixelRatio = 1

let pendingFrames = []
let frameHandle = 0
globalThis.requestAnimationFrame = (callback) => {
  pendingFrames.push(callback)
  frameHandle += 1
  return frameHandle
}
globalThis.cancelAnimationFrame = () => {
  pendingFrames = []
}

const { createFakeCanvas, createFakeContext, pressKey } = await import('../src/test/fakeCanvas.js')
const { createWorldEngine } = await import('../src/render/engine.js')
const { createAvatarAppearance } = await import('../src/render/avatarAppearance.js')
const { attenuationGain, stereoPan, createSpatialSink } = await import('../src/audio/spatialAudio.js')

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)
const fmt = (value, digits = 2) => Number(value).toFixed(digits)

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  }
}

// ------------------------------------------------------- deterministic crowd ---

const WORLD = { width: 2560, height: 1600 }
const FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2]

/**
 * Spread `count` avatars over the real world bounds and let them walk in a circle,
 * so every frame does real interpolation-free motion work (positions change, hence
 * culling/label/halo work changes) instead of measuring a static scene.
 */
function createCrowd(count, seed = 1) {
  const crowd = []
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const columnStep = columns > 1 ? (WORLD.width - 480) / (columns - 1) : 0
    crowd.push({
      id: `peer-${seed}-${index}`,
      name: `Peer ${index}`,
      x: 240 + column * columnStep,
      y: 200 + row * 180,
      facing: FACINGS[index % FACINGS.length],
      moving: index % 3 === 0,
      speaking: index % 5 === 0,
      muted: false,
      nearby: index % 2 === 0,
      stale: false,
      appearance: createAvatarAppearance(`peer-${seed}-${index}`),
    })
  }
  return crowd
}

/** Walk the crowd in a slow circle around the office centre. */
function moveCrowd(crowd, elapsed) {
  for (let index = 0; index < crowd.length; index += 1) {
    const peer = crowd[index]
    const radius = 200 + (index % 7) * 90
    const speed = 0.35 + (index % 5) * 0.05
    const angle = elapsed * speed + index
    peer.x = WORLD.width / 2 + Math.cos(angle) * radius
    peer.y = WORLD.height / 2 + Math.sin(angle) * radius * 0.6
    peer.facing = angle + Math.PI / 2
  }
}

// ------------------------------------------------------------ fake audio graph ---

function createFakeAudioParam(value = 0) {
  return {
    value,
    setValueAtTime(next) {
      this.value = next
      return this
    },
    setTargetAtTime(target) {
      this.value = target
      return this
    },
    linearRampToValueAtTime() {
      return this
    },
  }
}

function createFakeAudioContext() {
  const created = { sources: 0, gains: 0, panners: 0, writes: 0 }
  // Count every AudioParam write: that count is the "no per-frame graph churn" and
  // "automation only when something moved" evidence.
  const track = (node, param) => {
    for (const method of ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime']) {
      const original = param[method].bind(param)
      param[method] = (...callArgs) => {
        created.writes += 1
        return original(...callArgs)
      }
    }
    node[param === node.pan ? 'pan' : 'gain'] = param
    return node
  }
  return {
    created,
    sampleRate: 48_000,
    state: 'running',
    currentTime: 0,
    destination: { id: 'destination' },
    createMediaStreamSource: () => {
      created.sources += 1
      return { connect() {}, disconnect() {} }
    },
    createGain: () => {
      created.gains += 1
      const node = { gain: createFakeAudioParam(1), connect() {}, disconnect() {} }
      return track(node, node.gain)
    },
    createStereoPanner: () => {
      created.panners += 1
      const node = { pan: createFakeAudioParam(0), connect() {}, disconnect() {} }
      return track(node, node.pan)
    },
  }
}

// ---------------------------------------------------------------- the bench ---

const results = []

log('')
log('PROXI — render + spatial audio benchmark')
log(`node ${process.version} · ${FRAMES} measured frames per avatar count · ${WARMUP} warm-up frames`)
log('')

for (const avatarCount of AVATAR_COUNTS) {
  const store = {
    writes: 0,
    state: {},
    getSnapshot() {
      return this.state
    },
    set(patch) {
      this.writes += 1
      this.state = { ...this.state, ...patch }
      return this.state
    },
  }

  const context = createFakeContext({ width: 1440, height: 900 })
  const canvas = createFakeCanvas(1440, 900, context)
  const container = document.createElement('div')
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900 })
  container.focus = () => {}
  document.body.appendChild(container)

  const crowd = createCrowd(avatarCount)
  const engine = createWorldEngine({ canvas, container, store, playerName: 'Bench', spawnId: 'entrance' })
  // The peers walk, and so does the local player: a static scene would measure a
  // best case nobody ever sees (camera follow, collision, labels and halos all do
  // work only while something moves).
  engine.setPeerProvider((now) => {
    moveCrowd(crowd, now / 1000)
    return crowd
  })

  // Spatial audio side: one managed graph per remote stream, exactly as the engine
  // builds them, plus the frame hook that drives them from world coordinates.
  const audio = createFakeAudioContext()
  const streams = crowd.map((peer) => ({
    peer,
    stream: { id: peer.id, getAudioTracks: () => [{ kind: 'audio' }] },
  }))
  const sinks = streams.map((entry) => createSpatialSink({ stream: entry.stream, context: audio }))
  const hook = (frame) => {
    const { x, y } = frame.player
    for (let index = 0; index < sinks.length; index += 1) {
      const peer = streams[index].peer
      const dx = peer.x - x
      const dy = peer.y - y
      const distance = Math.hypot(dx, dy)
      sinks[index].setSpatial(attenuationGain(distance, frame.radius), stereoPan(dx, frame.radius))
    }
  }
  engine.setFrameHook(hook)

  // Deterministic clock: 60 fps, timestamps in ms, exactly like a browser.
  let clock = 0
  let callsBefore = null
  function step(count) {
    for (let index = 0; index < count; index += 1) {
      const callbacks = pendingFrames
      pendingFrames = []
      clock += 1000 / 60
      audio.currentTime += 1 / 60
      for (const callback of callbacks) callback(clock)
    }
  }

  engine.start()
  // Hold a walk key so the local avatar keeps moving (and the camera keeps following)
  // for the whole run.
  pressKey('KeyD', { target: container })
  pressKey('KeyW', { target: container })
  step(WARMUP)
  store.writes = 0
  // Count canvas ops for one steady-state frame.
  callsBefore = new Map(context.calls)
  step(1)
  const opsPerFrame = [...context.calls].reduce(
    (total, [name, count]) => total + count - (callsBefore.get(name) ?? 0),
    0,
  )
  context.calls.clear()

  // With --expose-gc the heap number is trustworthy: collect before sampling both
  // ends, so what remains is allocation that actually survived.
  const collect = () => {
    if (typeof globalThis.gc === 'function') globalThis.gc()
  }
  collect()
  const heapStart = WANT_HEAP ? process.memoryUsage().heapUsed : 0
  const samples = []
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const started = process.hrtime.bigint()
    step(1)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    samples.push(elapsedMs)
  }
  collect()
  const heapEnd = WANT_HEAP ? process.memoryUsage().heapUsed : 0

  const stats = summarise(samples)
  const nodeCounts = { ...audio.created }
  const diagnostics = engine.getDiagnostics()
  const audioWritesPerFrame = nodeCounts.writes / (FRAMES + WARMUP + 1)

  engine.destroy()
  container.remove()
  document.body.innerHTML = ''

  const row = {
    avatars: avatarCount,
    msPerFrameMean: stats.mean,
    msPerFrameP50: stats.p50,
    msPerFrameP95: stats.p95,
    msPerFrameMax: stats.max,
    budgetPercent: (stats.mean / 16.667) * 100,
    opsPerFrame,
    hudWritesPerFrame: store.writes / (FRAMES + 1),
    audioNodes: { sources: nodeCounts.sources, gains: nodeCounts.gains, panners: nodeCounts.panners },
    audioParamWritesPerFrame: audioWritesPerFrame,
    heapBytesPerFrame: WANT_HEAP ? (heapEnd - heapStart) / FRAMES : null,
    canvasOpsTotal: diagnostics.draws,
  }
  results.push(row)

  log(
    [
      `avatars ${String(avatarCount).padStart(3)}`,
      `| ${fmt(stats.mean, 3)} ms/frame mean`,
      `p95 ${fmt(stats.p95, 3)} ms`,
      `| ${fmt(row.budgetPercent, 1)}% of a 16.7 ms budget`,
      `| ${String(opsPerFrame).padStart(5)} ctx ops/frame`,
      `| hud ${fmt(row.hudWritesPerFrame, 2)}/frame`,
      `| audio writes ${fmt(audioWritesPerFrame, 1)}/frame`,
      WANT_HEAP ? `| ${fmt(row.heapBytesPerFrame, 1)} B/frame` : '',
    ]
      .filter(Boolean)
      .join(' '),
  )
}

// ------------------------------------------------------------------ summary ---

const baseline = results[0]
const largest = results[results.length - 1]
log('')
log(
  `AudioNodes for the largest run (${largest.avatars} streams): ` +
    `${largest.audioNodes.sources} source / ${largest.audioNodes.gains} gain / ${largest.audioNodes.panners} panner ` +
    `= ${largest.audioNodes.sources + largest.audioNodes.gains + largest.audioNodes.panners} nodes for ` +
    `${FRAMES + WARMUP + 1} frames. One managed graph per stream, built once: nothing is created in the loop.`,
)
log('')
log('Notes')
log('  · 16.7 ms budget   — one frame at 60 fps. Percentages are of that budget, on this machine.')
log('  · ctx ops          — recording-context calls per frame (not GPU work, not rasterised pixels).')
log('  · audio nodes      — created ONCE per stream for the whole run: no AudioNodes per frame.')
log('  · audio writes     — AudioParam automation calls per frame; unchanged values are skipped.')
log(`  · scaling          — ${baseline.avatars} → ${largest.avatars} avatars moved the frame from ` +
  `${fmt(baseline.msPerFrameMean, 3)} ms to ${fmt(largest.msPerFrameMean, 3)} ms ` +
  `(${fmt(largest.msPerFrameMean / Math.max(baseline.msPerFrameMean, 1e-6), 2)}x).`)
log('  · garbage          — the loop reuses one frame object per consumer; the proxy for that here is')
log('                       --heap (byte growth per frame) and the constant node/ops counts above.')
log('')

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ node: process.version, frames: FRAMES, avatarCounts: AVATAR_COUNTS, results }, null, 2)}\n`)
  log(`wrote ${JSON_OUT}`)
}
