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
  for (const event of [EVENTS.SNAPSHOT, EVENTS.JOINED, EVENTS.MOVED, EVENTS.LEFT, EVENTS.ERROR]) {
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
