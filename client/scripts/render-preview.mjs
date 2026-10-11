/**
 * Headless visual check — renders the office to a PNG at a chosen viewport size.
 *
 * This is a developer aid, not part of the app bundle. It runs the *real* render
 * pipeline (engine → worldRenderer/furniture/avatarRenderer) against a Node canvas
 * implementation so the layout can be eyeballed at any viewport without a browser.
 * Handy for the "furniture must not be clipped at different viewport sizes" check.
 *
 * Usage (needs an optional dev package, it is not a project dependency):
 *   npm install --no-save @napi-rs/canvas
 *   node scripts/render-preview.mjs --width 1440 --height 900 --out preview.png
 *
 * Options
 *   --width / --height   CSS pixels of the viewport (default 1440x900)
 *   --dpr                device pixel ratio (default 2)
 *   --zoom               camera zoom (default min zoom that fits the world)
 *   --spawn              spawn id to place the avatar (default entrance)
 *   --zone               teleport to the first spawn of a named zone instead
 *   --frames             simulated frames to run before capturing (default 90)
 *   --walk               key code to hold while simulating, e.g. KeyW
 *   --no-follow          free camera instead of following the player
 *   --no-labels          hide room labels
 *   --out                output png path (default preview.png)
 */
import { writeFileSync } from 'node:fs'

let createCanvas
try {
  ;({ createCanvas } = await import('@napi-rs/canvas'))
} catch {
  console.error(
    'This developer aid needs an optional canvas implementation (not a project dependency):\n' +
      '  npm install --no-save @napi-rs/canvas\n' +
      'then run it again.',
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : true
}
const hasFlag = (name) => args.includes(`--${name}`)

const width = Number(readArg('width', 1440))
const height = Number(readArg('height', 900))
const dpr = Number(readArg('dpr', 2))
const frames = Number(readArg('frames', 90))
const out = String(readArg('out', 'preview.png'))
const spawnId = String(readArg('spawn', 'entrance'))
const walkKey = readArg('walk', null)
const follow = !hasFlag('no-follow')
const showLabels = !hasFlag('no-labels')

// --- minimal DOM shim: the engine only touches these globals -----------------
const listeners = new Map()
const fakeWindow = {
  devicePixelRatio: dpr,
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: (type) => listeners.delete(type),
  dispatchEvent: () => true,
}
const fakeDocument = { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.window = fakeWindow
globalThis.document = fakeDocument
globalThis.devicePixelRatio = dpr

let clock = 0
let pending = null
globalThis.requestAnimationFrame = (callback) => {
  pending = callback
  return 1
}
globalThis.cancelAnimationFrame = () => {
  pending = null
}
const step = (count, deltaMs = 16) => {
  for (let i = 0; i < count; i += 1) {
    if (!pending) return
    const callback = pending
    pending = null
    clock += deltaMs
    callback(clock)
  }
}

const { createWorldEngine } = await import('../src/render/engine.js')

const canvas = createCanvas(Math.round(width * dpr), Math.round(height * dpr))
canvas.style = { width: `${width}px`, height: `${height}px` }
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height })
const container = { getBoundingClientRect: canvas.getBoundingClientRect, clientWidth: width, clientHeight: height }

const engine = createWorldEngine({
  canvas,
  container,
  store: { set: () => {}, getSnapshot: () => ({}) },
  playerName: 'You',
  spawnId,
})

const zone = readArg('zone', null)
const zoomRequested = readArg('zoom', null)

// start() attaches keyboard/pointer input, so a scripted walk below is real
// movement rather than a teleport.
engine.start()
if (typeof zone === 'string') {
  const { SPAWNS, ZONES } = await import('../src/world/worldData.js')
  const target = ZONES.find((entry) => entry.id === zone) ?? ZONES.find((entry) => entry.name.toLowerCase().includes(zone))
  // The spawn whose own room is the requested zone; otherwise the requested
  // zone's centre (teleporting is clamped by the walkable bounds and collision).
  const inZone = (point) =>
    target && point.x >= target.x && point.x <= target.x + target.w && point.y >= target.y && point.y <= target.y + target.h
  const spawn = SPAWNS.find((entry) => inZone(entry))
  if (spawn) engine.teleportTo(spawn.id)
  else {
    console.warn(`no spawn inside zone "${zone}", centring the camera on it`)
    engine.getCamera().centerOn(target.x + target.w / 2, target.y + target.h / 2)
    engine.setFollow(false)
  }
}
if (zoomRequested !== null) engine.getCamera().setZoom(Number(zoomRequested))
if (!follow) engine.toggleFollow()
if (!showLabels) engine.toggleLabels()

if (walkKey) {
  const event = { code: walkKey, key: walkKey, preventDefault() {}, target: null }
  listeners.get('keydown')?.(event)
}

step(frames)

if (walkKey) {
  listeners.get('keyup')?.({ code: walkKey, key: walkKey, preventDefault() {}, target: null })
}

const diagnostics = engine.getDiagnostics()
writeFileSync(out, canvas.toBuffer('image/png'))
console.log(
  JSON.stringify(
    {
      out,
      viewport: `${width}x${height} @${dpr}x`,
      spawn: diagnostics.spawnId,
      player: diagnostics.player,
      camera: diagnostics.camera,
      frames: diagnostics.frames,
      running: diagnostics.running,
    },
    null,
    2,
  ),
)
engine.destroy()
