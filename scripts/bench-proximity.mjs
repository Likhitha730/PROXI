#!/usr/bin/env node
// Proximity benchmark — what this actually measures, stated up front:
//
//   1. the IN-MEMORY proximity engine (server/src/realtime/proximity.js) on the real
//      registry, i.e. the code path that produces live "who is nearby" results. This
//      is a genuine measurement of this machine, this Node version and this data set.
//   2. the DATABASE query path (server/src/db/positions.js) against the in-process
//      double in server/src/test/fakeMongo.js.
//
// It does NOT measure MongoDB. This sandbox has no mongod, no Docker image and no
// route to the MongoDB downloads host (see docs/SESSION_05_REPORT.md), so any number
// printed for (2) is the cost of the JavaScript double, and must never be quoted as
// database performance. The double does implement the same planar `2d` semantics the
// real server would use, so it is a correctness reference, not a speed reference.
//
// Usage: node scripts/bench-proximity.mjs [--players 24] [--iterations 2000]

import process from 'node:process'
import { createPlayerRegistry } from '../server/src/realtime/registry.js'
import { createProximityEngine, findNeighbours } from '../server/src/realtime/proximity.js'
import { createPositionsRepository } from '../server/src/db/positions.js'
import { createFakeDatabase } from '../server/src/test/fakeMongo.js'
import { LIMITS } from '../shared/protocol.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : Number(args[index + 1])
}

const ROOM_SIZE = readArg('players', 24)
const ITERATIONS = readArg('iterations', 2000)
const RADIUS = LIMITS.PROXIMITY_RADIUS

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)

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

function formatMicroseconds(milliseconds) {
  return `${(milliseconds * 1000).toFixed(1)} us`
}

/**
 * Deterministic office-like layout: players spread over the real world bounds
 * (2560 x 1600). With the default radius several of them are genuinely in range of
 * each other, otherwise the benchmark would measure nothing but misses.
 */
function createPlayers(count) {
  const registry = createPlayerRegistry({ idFactory: (() => { let n = 0; return () => `player-${++n}` })() })
  for (let index = 0; index < count; index += 1) {
    const socketId = `socket-${index}`
    registry.add({ socketId, name: `Player ${index}` })
    // Clustered around two hubs, as a real office population would be.
    const hub = index % 2 === 0 ? { x: 640, y: 640 } : { x: 1900, y: 1100 }
    const angle = (index / count) * Math.PI * 4
    const spread = 60 + (index % 5) * 45
    registry.move(socketId, {
      x: hub.x + Math.cos(angle) * spread,
      y: hub.y + Math.sin(angle) * spread,
      moving: false,
    })
  }
  return registry
}

/**
 * The reference answer: every player inside the radius, nearest first, truncated to
 * the same documented cap the engine applies (LIMITS.PROXIMITY_MAX_NEIGHBOURS).
 */
function bruteForce(players, origin, radius) {
  const inside = players
    .filter((player) => player.id !== origin.id)
    .map((player) => ({ id: player.id, distance: Math.hypot(player.x - origin.x, player.y - origin.y) }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
  return { inside, saturates: inside.length > LIMITS.PROXIMITY_MAX_NEIGHBOURS, kept: inside.slice(0, LIMITS.PROXIMITY_MAX_NEIGHBOURS) }
}

async function main() {
  log('')
  log(`ProxiSpeak proximity benchmark — ${ROOM_SIZE} players, ${ITERATIONS} iterations, radius ${RADIUS} u`)
  log(`node ${process.version} on ${process.platform}/${process.arch}`)
  log('')

  const registry = createPlayers(ROOM_SIZE)
  const players = registry.list()

  // ------------------------------------------------------------------ engine ---
  const engine = createProximityEngine({ registry, onUpdate: () => {} })
  for (let index = 0; index < ROOM_SIZE; index += 1) engine.track(`socket-${index}`)

  // Warm up, then measure one full recompute of every player (the join/leave path).
  for (let index = 0; index < 20; index += 1) engine.updateAll({ publish: false })

  const fullSweep = []
  for (let index = 0; index < ITERATIONS / 20; index += 1) {
    const started = performance.now()
    engine.updateAll({ publish: false })
    fullSweep.push(performance.now() - started)
  }

  // One player's neighbourhood: the unit of work behind a movement update.
  const singleUpdate = []
  const subject = registry.get('socket-0')
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now()
    engine.findNeighboursFor(subject.x, subject.y, { excludeId: subject.id })
    singleUpdate.push(performance.now() - started)
  }

  // Same work with the shared grid, which is what `update()` uses.
  const gridUpdate = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now()
    findNeighbours({ id: subject.id, x: subject.x, y: subject.y }, players, { radius: RADIUS })
    gridUpdate.push(performance.now() - started)
  }

  const sweep = summarise(fullSweep)
  const single = summarise(singleUpdate)
  const grid = summarise(gridUpdate)

  log('in-memory proximity engine (real code path, registry-backed)')
  log(`  full room sweep (${ROOM_SIZE} listeners answered from one grid build)`)
  log(`    mean ${formatMicroseconds(sweep.mean)}   p50 ${formatMicroseconds(sweep.p50)}   p95 ${formatMicroseconds(sweep.p95)}   max ${formatMicroseconds(sweep.max)}`)
  log(`    → ${(1000 / sweep.mean).toFixed(0)} sweeps/second`)
  log(`  one player neighbourhood, grid query + hysteresis`)
  log(`    mean ${formatMicroseconds(grid.mean)}   p95 ${formatMicroseconds(grid.p95)}`)
  log(`  one player neighbourhood, all-pairs scan (for comparison)`)
  log(`    mean ${formatMicroseconds(single.mean)}   p95 ${formatMicroseconds(single.p95)}`)
  log(`    → grid is ${(single.mean / grid.mean).toFixed(2)}x the all-pairs scan at this size`)
  log('')

  // ------------------------------------------------------- correctness check ---
  // The grid must return exactly what an all-pairs scan returns, or the fast path is
  // not a fast path, it is a different answer.
  let mismatches = 0
  let saturated = 0
  const disagreements = []
  for (const player of players) {
    const result = findNeighbours({ id: player.id, x: player.x, y: player.y }, players, { radius: RADIUS })
    const reference = bruteForce(players, player, RADIUS)
    if (reference.saturates) saturated += 1
    if (reference.saturates !== result.saturates) mismatches += 1

    /*
     * Compare the *distances* of the returned neighbours, not the ids.
     *
     * Two players can sit at exactly the same distance from the listener (the layout is
     * symmetric), and when the cap truncates the list, which of two equidistant players
     * is kept is arbitrary by design — the invariant that matters is "the N nearest".
     * The ids are checked separately: every returned player must really be in range.
     */
    const round = (value) => value.toFixed(6)
    const gridDistances = result.neighbours.map((entry) => round(entry.distance)).sort()
    const scanDistances = reference.kept.map((entry) => round(entry.distance)).sort()
    const idsAreReal = result.neighbours.every((entry) =>
      reference.inside.some((candidate) => candidate.id === entry.id),
    )
    if (gridDistances.join('|') !== scanDistances.join('|') || !idsAreReal) {
      mismatches += 1
      disagreements.push(player.name)
    }
  }
  log(`exactness: ${ROOM_SIZE - mismatches}/${ROOM_SIZE} players agree with an all-pairs scan`)
  if (saturated > 0) {
    log(`  note: ${saturated} player(s) have more than ${LIMITS.PROXIMITY_MAX_NEIGHBOURS} neighbours inside the radius,`)
    log('  so their result is truncated to the documented cap — the reference is truncated too.')
  }
  if (disagreements.length > 0) log(`  disagreements: ${disagreements.join(', ')}`)
  log('')

  // ------------------------------------------------------------- repository ----
  // The double, NOT MongoDB. See the header: no mongod exists in this sandbox.
  const db = createFakeDatabase()
  const repository = createPositionsRepository({ getDatabase: () => db.database, logger: null })
  const writes = []
  for (const player of players) {
    const started = performance.now()
    await repository.savePosition({ sessionId: player.id, name: player.name, x: player.x, y: player.y })
    writes.push(performance.now() - started)
  }
  const queries = []
  for (let index = 0; index < Math.max(200, ITERATIONS / 10); index += 1) {
    const started = performance.now()
    await repository.findNearby({ x: subject.x, y: subject.y, radius: RADIUS, excludeSessionId: subject.id })
    queries.push(performance.now() - started)
  }
  const write = summarise(writes)
  const query = summarise(queries)

  log('repository against the IN-PROCESS DOUBLE (not MongoDB — no mongod in this sandbox)')
  log(`  savePosition upsert: mean ${formatMicroseconds(write.mean)}   p95 ${formatMicroseconds(write.p95)}`)
  log(`  findNearby planar $near query: mean ${formatMicroseconds(query.mean)}   p95 ${formatMicroseconds(query.p95)}`)
  log(`  documents in the collection: ${db.documentsIn('positions').length}`)
  log('')
  log('These repository numbers measure server/src/test/fakeMongo.js. There is no')
  log('MongoDB server in this environment, so no database performance is claimed.')
  log('')
}

main().catch((error) => {
  process.stderr.write(`benchmark failed: ${error?.stack ?? error}\n`)
  process.exit(1)
})
