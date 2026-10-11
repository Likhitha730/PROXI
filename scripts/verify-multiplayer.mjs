#!/usr/bin/env node
// Multiplayer verification: drives two independent Socket.IO clients through the
// ProxiSpeak protocol and checks the behaviour a pair of browser sessions should
// show. This is the scripted version of the manual two-window checklist in
// docs/SESSION_04_REPORT.md.
//
// Usage:
//   node scripts/verify-multiplayer.mjs                       # via the Vite proxy
//   SMOKE_URL=http://127.0.0.1:8080 node scripts/verify-multiplayer.mjs
//
// Exits non-zero on the first failed check.

import process from 'node:process'
import { io } from 'socket.io-client'
import { EVENTS } from '../shared/protocol.js'

const BASE_URL = (process.env.SMOKE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const ORIGIN = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173'
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 8000)

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'
  process.stdout.write(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function fail(name, detail) {
  record(name, false, detail)
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

function connect(name) {
  const socket = io(BASE_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: TIMEOUT_MS,
    extraHeaders: { origin: ORIGIN },
  })
  socket.__name = name
  socket.__events = []
  for (const event of [EVENTS.SNAPSHOT, EVENTS.JOINED, EVENTS.MOVED, EVENTS.LEFT, EVENTS.PROXIMITY, EVENTS.ERROR]) {
    socket.on(event, (payload) => socket.__events.push({ event, payload }))
  }
  return socket
}

/** Resolve once the transport is up (works whether or not it beat us to it). */
async function ready(socket, label) {
  if (socket.connected) return
  await waitFor(socket, 'connect', { label })
}

/** Wait for the roster reply, then introduce ourselves. */
async function join(socket, name) {
  const snapshot = waitFor(socket, EVENTS.SNAPSHOT, { label: `snapshot for ${name}` })
  socket.emit(EVENTS.JOIN, { name })
  return snapshot
}

/**
 * Walk along a straight line the way a browser must: the server enforces 205 u/s
 * plus slack, so one long jump is rejected. Steps stay inside the allowance and the
 * pause exceeds the 4 Hz proximity interval, which also refreshes our own distances.
 */
async function walkTo(socket, from, to, { stepUnits = 45, pauseMs = 280 } = {}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepUnits))
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps
    socket.emit(EVENTS.MOVE, {
      x: from.x + dx * progress,
      y: from.y + dy * progress,
      dir: 0,
      moving: true,
      clientTs: Date.now(),
    })
    await sleep(pauseMs)
  }
  return { x: to.x, y: to.y }
}

/** The most recent proximity result this socket received, if any. */
function lastProximity(socket) {
  return socket.__events.filter((entry) => entry.event === EVENTS.PROXIMITY).at(-1)?.payload ?? null
}

function nearbyNames(socket) {
  return (lastProximity(socket)?.neighbours ?? []).map((entry) => entry.name)
}

async function main() {
  process.stdout.write(`\nProxiSpeak multiplayer check → ${BASE_URL}\n\n`)

  // --- two sessions join ---------------------------------------------------
  // Both transports first, then the joins in a fixed order — no races between
  // "socket connected" and "someone joined".
  const alice = connect('alice')
  const bob = connect('bob')
  await ready(alice, 'connect for Alice')
  await ready(bob, 'connect for Bob')

  const aliceSnapshot = await join(alice, 'Alice')
  const bobJoinedNotice = waitFor(alice, EVENTS.JOINED, { label: 'Alice sees Bob join' })
  const bobSnapshot = await join(bob, 'Bob')

  record(
    'first session joins with a server-minted id and an empty roster',
    Boolean(aliceSnapshot?.self?.id) && aliceSnapshot.players.length === 0,
    `id=${aliceSnapshot?.self?.id?.slice(0, 8)} position=(${aliceSnapshot?.self?.x},${aliceSnapshot?.self?.y})`,
  )
  record(
    'second session receives the existing player in its snapshot',
    bobSnapshot?.players?.length === 1 && bobSnapshot.players[0].name === 'Alice',
    `roster=[${bobSnapshot?.players?.map((player) => player.name).join(', ')}]`,
  )
  record('first session is notified that the second joined', Boolean((await bobJoinedNotice)?.player?.id))

  // --- movement in both directions ----------------------------------------
  const bobSeesAlice = waitFor(bob, EVENTS.MOVED, { filter: (update) => update.id === aliceSnapshot.self.id })
  const targetX = aliceSnapshot.self.x - 12
  alice.emit(EVENTS.MOVE, { x: targetX, y: aliceSnapshot.self.y, dir: 3.14, moving: true, clientTs: Date.now() })
  const aliceMove = await bobSeesAlice
  record(
    'movement from session 1 is broadcast to session 2',
    Math.abs(aliceMove.x - targetX) < 0.5 && aliceMove.moving === true,
    `x=${aliceMove.x} (sent ${targetX})`,
  )

  const aliceSeesBob = waitFor(alice, EVENTS.MOVED, { filter: (update) => update.id === bobSnapshot.self.id })
  bob.emit(EVENTS.MOVE, { x: bobSnapshot.self.x + 10, y: bobSnapshot.self.y, dir: 0, moving: true, clientTs: Date.now() })
  const bobMove = await aliceSeesBob
  record('movement from session 2 is broadcast to session 1', Math.abs(bobMove.x - (bobSnapshot.self.x + 10)) < 0.5, `x=${bobMove.x}`)

  // --- validation and authority -------------------------------------------
  const badName = connect('mallory')
  await ready(badName, 'connect for bad name')
  const nameError = waitFor(badName, EVENTS.ERROR)
  badName.emit(EVENTS.JOIN, { name: '<script>alert(1)</script>' })
  const rejection = await nameError
  record('an invalid display name is rejected', rejection.code === 'invalid_name', `code=${rejection.code}`)
  badName.disconnect()

  const teleportError = waitFor(alice, EVENTS.ERROR)
  alice.emit(EVENTS.MOVE, { x: 100, y: 100, dir: 0, moving: true, clientTs: Date.now() })
  const correction = await teleportError
  record(
    'a teleport is rejected and the server returns the authoritative position',
    correction.code === 'invalid_position' && Number.isFinite(correction.data?.x),
    `corrected to (${correction.data?.x}, ${correction.data?.y})`,
  )

  const beforeFlood = alice.__events.filter((entry) => entry.event === EVENTS.MOVED).length
  for (let i = 0; i < 80; i += 1) {
    alice.emit(EVENTS.MOVE, { x: aliceSnapshot.self.x - 12 + i * 0.01, y: 1500, dir: 0, moving: true, clientTs: Date.now() })
  }
  await sleep(400)
  const rateLimited = alice.__events.some((entry) => entry.event === EVENTS.ERROR && entry.payload.code === 'rate_limited')
  record('a movement flood is rate limited', rateLimited, `${beforeFlood} broadcasts before the burst`)

  // --- proximity ------------------------------------------------------------
  // The server announces the listening radius on join and again whenever the set of
  // nearby players changes.
  const aliceProximity = lastProximity(alice)
  record(
    'a joining session is told its listening radius',
    aliceProximity?.radius === 100 && Array.isArray(aliceProximity.neighbours),
    `radius=${aliceProximity?.radius} neighbours=${aliceProximity?.neighbours?.length ?? 'n/a'}`,
  )
  record(
    'a player is never listed as their own neighbour',
    (aliceProximity?.neighbours ?? []).every((entry) => entry.id !== aliceSnapshot.self.id),
    `self=${aliceSnapshot.self.id.slice(0, 8)}`,
  )

  // Walk Bob away, then back towards Alice, so the check exercises real movement
  // rather than a teleport the server would (correctly) reject.
  const bobStart = { x: bobSnapshot.self.x, y: bobSnapshot.self.y }
  const far = { x: bobStart.x + 320, y: bobStart.y }
  await walkTo(bob, bobStart, far)
  await sleep(300)
  record(
    'a player outside the radius is not nearby',
    !nearbyNames(bob).includes('Alice'),
    `bob sees [${nearbyNames(bob).join(', ') || 'nobody'}] after walking away`,
  )

  // Alice stands still; Bob walks back until he is inside her radius.
  const aliceSeesBobApproach = waitFor(alice, EVENTS.PROXIMITY, {
    filter: (payload) => payload.neighbours.some((entry) => entry.name === 'Bob'),
    label: 'Alice is told that Bob walked into range',
  })
  await walkTo(bob, far, { x: aliceSnapshot.self.x + 40, y: aliceSnapshot.self.y })
  await sleep(300)

  let aliceNotified = null
  try {
    aliceNotified = await aliceSeesBobApproach
  } catch {
    aliceNotified = null
  }
  record(
    'a stationary player is told when somebody walks into range',
    Boolean(aliceNotified),
    aliceNotified ? `distance=${Math.round(aliceNotified.neighbours[0].distance)}u` : 'no proximity:update received',
  )

  const bobNearby = lastProximity(bob)?.neighbours ?? []
  record(
    'the walker sees the player they approached, with a distance',
    bobNearby.some((entry) => entry.name === 'Alice' && Number.isFinite(entry.distance)),
    `bob sees [${bobNearby.map((entry) => `${entry.name}@${Math.round(entry.distance)}u`).join(', ') || 'nobody'}]`,
  )
  record(
    'nearby entries carry a position, a distance and a deduplicated id',
    bobNearby.every(
      (entry) =>
        Number.isFinite(entry.x) &&
        Number.isFinite(entry.y) &&
        Number.isFinite(entry.distance) &&
        entry.nearby === true,
    ) && new Set(bobNearby.map((entry) => entry.id)).size === bobNearby.length,
    `${bobNearby.length} entr${bobNearby.length === 1 ? 'y' : 'ies'}`,
  )

  // --- disconnect cleanup --------------------------------------------------
  const movesBeforeLeave = alice.__events.filter(
    (entry) => entry.event === EVENTS.MOVED && entry.payload.id === bobSnapshot.self.id,
  ).length

  const leftNotice = waitFor(alice, EVENTS.LEFT, { filter: (payload) => payload.id === bobSnapshot.self.id })
  bob.disconnect()
  const left = await leftNotice
  record('disconnecting removes the player and notifies the other session', left.id === bobSnapshot.self.id, `left=${left.id.slice(0, 8)}`)

  await sleep(300)
  const movesAfterLeave = alice.__events.filter(
    (entry) => entry.event === EVENTS.MOVED && entry.payload.id === left.id,
  ).length
  record(
    'the removed player stops producing updates',
    movesAfterLeave === movesBeforeLeave,
    `${movesAfterLeave - movesBeforeLeave} updates after the disconnect`,
  )

  // A disconnected session must vanish from everyone's nearby list immediately.
  await sleep(300)
  const afterLeave = lastProximity(alice)
  record(
    'a disconnected player is removed from the nearby list',
    !(afterLeave?.neighbours ?? []).some((entry) => entry.id === left.id),
    `alice sees [${(afterLeave?.neighbours ?? []).map((entry) => entry.name).join(', ') || 'nobody'}]`,
  )

  alice.disconnect()
  await sleep(100)

  const passed = results.filter((result) => result.ok).length
  process.stdout.write(`\n${passed}/${results.length} checks passed\n\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  fail('verification script', error.message)
  process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed\n\n`)
  process.exit(1)
})
