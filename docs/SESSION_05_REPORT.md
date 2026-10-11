# Session 5 report — MongoDB persistence and the geospatial proximity engine

Scope: this session adds (a) a documented MongoDB **archive** of player positions with
a planar geospatial index, (b) an in-memory **proximity engine** with a 100-unit
listening radius, and (c) the client side of proximity — a nearby list with distances
and a ring drawn around the local avatar. No WebRTC was implemented.

Everything the previous session shipped (presence, snapshots, validated movement,
interpolation) keeps its exact wire contract; the only protocol addition is one new
server→client event.

---

## 1. Read this first: what was verified against what

This sandbox has **no MongoDB server**, and that shapes every number below.

| Attempted | Result |
|-----------|--------|
| `which mongod` / `which mongosh` | not installed |
| `which docker` | not installed (no container runtime) |
| `curl https://fastdl.mongodb.org/...` | connection failed (no route to the download host) |
| cached `.deb` packages | none |

So the persistence code path is exercised against a **documented in-process double**,
`server/src/test/fakeMongo.js`, which implements the driver surface this feature uses
(`updateOne` with `$set`/`$setOnInsert`/upsert, `bulkWrite`, `find` with planar `$near`
sorted ascending by Euclidean distance, `$geoWithin: { $center }`, `countDocuments`,
`deleteMany`, `createIndex`/`listIndexes` including the real conflict codes 85/86/68
and `NamespaceNotFound` 26) plus plan-`2d` query semantics.

Consequences, stated plainly:

* **No MongoDB performance is claimed anywhere in this report.** The repository timings
  in §6 are timings of the *double*, and are labelled as such in the output of
  `scripts/bench-proximity.mjs` itself.
* The **live** proximity path (the one that answers users) is measured for real, because
  it is pure in-memory code and needs no database (§6).
* There is also **no browser** in this environment: the two-window verification is
  reproduced by scripted Socket.IO clients (`scripts/verify-multiplayer.mjs`, 17 checks)
  plus the manual procedure in §7. Client-side rendering logic (the ring, the nearby
  list, the throttled HUD updates) is verified with jsdom + a recording fake canvas, not
  by looking at a screen.

## 2. Files

**New — server**

| File | Purpose |
|------|---------|
| `server/src/db/schema.js` | The spatial model and the persisted shape: `POSITIONS_SCHEMA_VERSION`, `INDEX_BOUNDS`, `POSITION_TTL_SECONDS`, `positionsIndexSpecs()`, `buildPositionDocument()`, `sameIndexKey()`, `compareIndex()` |
| `server/src/db/indexes.js` | `ensureIndexes({ collection, specs, logger })` — idempotent, never throws, never drops |
| `server/src/db/positions.js` | `createPositionsRepository()`: `savePosition`, `saveMany`, `markDisconnected`, `findNearby`, `findWithinBox`, `count`, `pruneStale`, `ensureIndexes`, `isAvailable`, `stats` |
| `server/src/realtime/proximity.js` | `findNeighbours()` + `createProximityEngine()`: uniform grid, hysteresis, throttles, `update` / `updateAffected` / `updateAll` / `track` / `forget` / `resultFor` / `reset` / `describe` |
| `server/src/realtime/spatialCheck.js` | 30 s cross-check of the database `$near` result against the in-memory grid; logs disagreements, never fatal |
| `server/src/test/fakeMongo.js` | The documented MongoDB double used by the tests (§1) |
| `server/src/test/silentLogger.js` | Recording logger for tests that must assert on *what* was logged |
| `server/src/db/positions.test.js` | 22 tests: schema, index specs, writes, queries, unavailability |
| `server/src/db/indexes.test.js` | 8 tests: creation, idempotency, conflicts, concurrent creation, failures |
| `server/src/realtime/proximity.test.js` | 33 tests: radius semantics, dedupe, self-exclusion, liveness, throttling, hysteresis, `updateAffected`, hostile input |
| `server/src/realtime/spatialCheck.test.js` | 9 tests: agreement, lag reporting, unavailability, query shape |
| `server/src/sockets/proximity.test.js` | 15 integration tests over real sockets: proximity frames, boundary, reconnects, invalid moves, database failures and recovery |

**New — client / scripts / docs**

| File | Purpose |
|------|---------|
| `scripts/bench-proximity.mjs` | Benchmarks the in-memory engine (real) and the repository (against the double), labelled honestly in its own output |
| `scripts/verify-multiplayer.mjs` (extended) | 17 live checks now including proximity: radius announced, no self-listing, out-of-range, walk-up notification, distances, disconnect removal |
| `docs/ARCHITECTURE.md` §5/§6/§7 (updated) | Proximity service, the `proximity:update` event, and the database strategy rewritten to what is implemented |

**Changed — server**

* `shared/protocol.js`: 8th event `proximity:update`; `LIMITS.PROXIMITY_RADIUS` (100),
  `PROXIMITY_UPDATES_PER_SECOND` (4), `PROXIMITY_MIN_MOVEMENT` (8),
  `PROXIMITY_HYSTERESIS` (12), `PROXIMITY_MAX_NEIGHBOURS` (16); `createProximityResult()`,
  `proximityResultsEqual()`, plus `findNeighbours`-side rounding via `roundCoord`.
* `server/src/config/env.js`: `mongoCollection` (`MONGODB_COLLECTION`, default
  `positions`), `proximityRadius` (`PROXIMITY_RADIUS`, 1–2000), `positionFlushMs`
  (`POSITION_FLUSH_MS`, 250–60000).
* `server/src/sockets/handlers.js`: proximity + persistence wiring (see §4).
* `server/src/index.js`: positions repository and spatial check are constructed per
  server but **no database work starts until `main()` calls `runStartupTasks()`**;
  graceful shutdown flushes live positions before closing.
* `server/src/realtime/registry.js`: `socketIdFor(playerId)` so a player id can be
  addressed as a connection.
* `server/src/routes/health.js`: publishes `moveHz` and `proximityRadius` (constants,
  not deployment config — no environment values, no connection strings).
* `server/src/routes/health.js` / `README.md` / `server/.env.example`: documented new
  keys, placeholders only.

**Changed — client**

* `client/src/net/socketClient.js`: binds `proximity:update` into the presence model.
* `client/src/net/presence.js`: `applyProximity()`, `getProximity()`, `proximityRadius`;
  peer objects carry `nearby`/`distance` for the canvas hot path.
* `client/src/components/PresencePanel.jsx`: a **Nearby** block listing each nearby
  player and their distance, plus nearby markers on the roster.
* `client/src/render/engine.js`: `DEFAULT_PROXIMITY_RADIUS`, `setProximitySource()`,
  `drawProximityRing()` (soft floor glow + dashed boundary + a halo on every nearby
  peer), and `proximityRadius` in the HUD snapshot.
* `client/src/components/WorldCanvas.jsx`: feeds `presence.getProximity()` to the engine.
* `client/src/styles/global.css`: styles for the nearby list and nearby markers.

## 3. Database schema and index strategy

**Coordinate representation — planar, deliberately not GeoJSON.**
The office is a flat 2560 x 1600 pixel world. GeoJSON + a `2dsphere` index would treat
`[x, y]` as longitude/latitude on a sphere: distances would come back in metres along
great circles and any point with `y > 90` would be rejected outright — this world's
`y` runs to 1600. The chosen representation is the legacy **planar pair**
`location: [x, y]` with a **`2d`** index, which answers distances in world units:

```js
db.positions.createIndex({ location: '2d' }, { name: 'location_2d', min: 0, max: 2560 })
```

A `2d` index range is square, so the bound must cover the longer axis (2560); the
world's smaller `y` range simply occupies the lower part of it. This is documented in
`server/src/db/schema.js` next to the specs.

**Collection `positions`, one live document per session:**

```js
{
  sessionId: 'f68f11d0-…',   // the server-minted player uuid — never a client value
  name: 'Ada',
  location: [x, y],          // planar pair, 2d-indexed, rounded to 2 decimals
  connected: true,           // false once the session ends; the record survives
  schemaVersion: 1,
  firstSeenAt: Date,         // $setOnInsert, so it stays the first sighting
  updatedAt: Date
}
```

**Indexes** (`positionsIndexSpecs()`), created on every successful startup:

| Name | Key | Options | Why |
|------|-----|---------|-----|
| `location_2d` | `{ location: '2d' }` | `min: 0, max: 2560` | planar proximity queries |
| `sessionId_unique` | `{ sessionId: 1 }` | `unique: true` | exactly one live record per session, and makes the position upsert idempotent under concurrency |
| `updatedAt_ttl` | `{ updatedAt: 1 }` | `expireAfterSeconds: 86400` | the archive expires itself; `pruneStale` handles the coarse case |

**Idempotency and existing indexes** (`ensureIndexes`): the collection is listed first;
an index with the same key is compared field by field — identical means untouched (no
DDL), different options are reported as a conflict and **left exactly as they are,
never dropped**. A missing index is created; `IndexAlreadyExists` (68, a concurrent
startup) and `IndexOptionsConflict`/`IndexKeySpecsConflict` (85/86) are treated as
"reported, not fatal"; `NamespaceNotFound` (26) means a fresh database and is handled;
any other driver error is logged and returned in the report. Throwing is never an
option — the realtime server must run with a broken database.

**Queries** (`server/src/db/positions.js`):

```js
{ location: { $near: [x, y], $maxDistance: r } }        // ascending planar distance
{ location: { $geoWithin: { $center: [[x, y], r] } } }  // area reads
```

`findNearby` adds `connected: true`, a freshness window (`updatedAt >= now - maxAgeMs`)
and self-exclusion, and can be intersected with the **live** session id set so an
archived row can never pose as an active user.

## 4. Proximity engine

* **Live state only.** The engine reads the in-memory registry (connected sessions).
  The database is the archive; a session that disconnects disappears from every nearby
  list immediately (`proximity.forget` + `player:left` + a forced sweep), while its
  `positions` record is merely flagged `connected: false`.
* **Grid.** Cell size = radius (100 u); a listener's neighbours are found by scanning
  the 3x3 cell block, which provably contains every point within 100 u. `updateAll()`
  answers every listener from **one** grid build; `updateAffected()` does the same.
* **Documented result** (internal shape == wire shape):

  ```js
  { id, radius: 100, at: <ms>, neighbours: [{ id, name, x, y, distance, nearby: true }] }
  ```

  nearest first, self excluded, deduplicated by id, capped at 16 entries, coordinates
  and distances rounded by the shared `roundCoord`.
* **Throttling.** A listener is recomputed when ≥250 ms have passed (4 Hz) **and** they
  moved ≥8 u; a **forced** update (join/leave) skips both, and a **neighbour-triggered**
  update (`updateAffected`) skips the movement budget only — otherwise a player standing
  still would never notice a colleague walking up to them. Publishing happens when the
  neighbour **set** changes, when forced, or when the listener has moved enough to make
  the distances worth redrawing. Standing still therefore produces no traffic at all
  (asserted in `server/src/sockets/proximity.test.js`).
* **Hysteresis.** A player who was nearby stays nearby until radius + 12 u, so walking
  exactly on the boundary does not flap the audio/UI state.
* **Wiring** (`handlers.js`): join → forced position write, `proximity.track`, forced
  sweep; accepted move → `proximity.updateAffected(socket.id)` + a throttled position
  write; disconnect → `proximity.forget`, `markDisconnected`, forced sweep.
* **Database failure tolerance.** Every repository method returns
  `{ ok: false, reason: 'database unavailable' }` instead of throwing; the handlers count
  it in `stats.persistFailures` and carry on. A test does exactly that — breaks *every*
  database call mid-session — and asserts that proximity still works and later joins
  still get a full snapshot.

## 5. Client integration

* `proximity:update` → `presence.applyProximity()`: builds the nearby list (deduped,
  nearest first, self filtered defensively), stamps `nearby`/`distance` onto the peer
  objects the canvas already reads, and adopts the server's radius.
* **React stays calm.** Membership changes re-render immediately; distance-only changes
  are rate-limited to 500 ms, so a walking neighbour cannot re-render the HUD four times
  a second. The model itself is always current — only the notification is throttled.
* `PresencePanel` renders a **Nearby** block (`within 100 u`) listing each player and
  their distance in world units, and marks nearby players in the full roster.
* `engine.drawProximityRing()` draws the ring on the floor around the local avatar: a
  soft radial glow, a dashed boundary at exactly the radius (marching slowly), and a
  halo on every nearby peer — so the picture and the list can never disagree. It draws
  under depth-sorted furniture/avatars and restores the line-dash state.
* The radius comes from the server (`proximity.radius`), with the shared constant as
  fallback; `health.realtime.proximityRadius` publishes it before the first update.

## 6. Measured behaviour (what these numbers are, and are not)

`node scripts/bench-proximity.mjs` — Node v22.22.3, linux/x64, this container, three
runs per configuration. **Only the first block is a measurement of production code.**

**In-memory proximity engine (real code path, registry-backed)**

| Configuration | Mean | p50 | p95 | Throughput |
|---|---|---|---|---|
| Full room sweep, 24 listeners from one grid build | 113–125 µs | ~82 µs | 224–287 µs | ~8,000–8,800 sweeps/s |
| One listener's neighbourhood (grid + hysteresis) | 7–11 µs | — | 8–18 µs | — |
| Same, via an all-pairs scan (comparison) | 8–11 µs | — | 9–18 µs | — |
| Full sweep, 200 listeners | ~1.9 ms | 1.7 ms | 2.6 ms | ~530 sweeps/s |

Two honest observations rather than a sales pitch:

1. At the 24-player room cap the grid is **roughly at parity** with an all-pairs scan
   (0.9–1.3x across runs) because a sweep builds a grid for the whole room; the grid's
   value here is exactness and headroom, not speed. Sharing one grid per sweep did make
   `updateAll` measurably faster than building it per listener (about 1.5x: ~190 µs →
   ~120 µs mean at 24 listeners).
2. The 4 Hz publication budget for 24 listeners is 250 ms against a measured ~0.12 ms
   sweep — three orders of magnitude of headroom *on this machine*.

**Repository against the in-process double — not MongoDB**

| Operation | Mean | p95 |
|---|---|---|
| `savePosition` upsert | 47–53 µs | 117–164 µs |
| `findNearby` planar `$near` | 47–60 µs | 59–81 µs |

These measure `server/src/test/fakeMongo.js`. **No MongoDB latency, throughput or index
behaviour is measured or claimed in this session** — there is no server to measure.

**Correctness measurement:** `findNeighbours` was compared against a brute-force
all-pairs scan for every player in the room: 24/24 and 200/200 players agree on the
documented invariant (the N nearest within the radius, truncated to the cap). Ids are
verified to be genuinely in range; which of two *equidistant* players survives a
truncation is arbitrary by design.

## 7. Verification: commands and results

```
client  npx vitest run          → 222 passed (15 files)
server  npx vitest run          → 158 passed (12 files)
root    npx eslint .            → clean
root    npm run build           → 90 modules, 277.77 kB js (89.20 kB gz), 11.45 kB css (3.28 kB gz)
```

Live checks against a running backend (persistence disabled — no `MONGODB_URI`, the
documented valid state):

```
node scripts/verify-multiplayer.mjs                                 → 17/17 (via the Vite proxy, port 5173)
SMOKE_URL=http://127.0.0.1:8080 node scripts/verify-multiplayer.mjs → 17/17 (direct, port 8080)
node scripts/smoke-socket.mjs                                       → 5/5
curl /api/health → {"status":"ok", …, "realtime":{"socketio":true,"moveHz":15,"proximityRadius":100}}
```

The 7 new live checks: the radius is announced on join; a player is never listed as
their own neighbour; someone outside the radius is not nearby; a **stationary** player
is told (with a distance) when another walks into range; the walker sees who they
approached, with positions and distances; nearby entries are deduplicated with a
position and a distance; a disconnected player disappears from the nearby list.

**Manual two-window procedure** (the check this environment cannot perform itself,
because there is no browser):

1. `npm run dev` → open <http://localhost:5173> in two windows (or one window + one
   private window, so the display names differ).
2. Both windows should show *2 players online*; each shows the other in the roster.
3. Walk one avatar toward the other. Inside 100 units: a cyan ring is visible on the
   floor around **your** avatar, the approaching player picks up a halo, and the
   **Nearby** panel lists them with a distance in world units that shrinks as you close
   in. Listeners standing still must also see the change *without pressing a key*.
4. Walk apart past ~112 units (the hysteresis margin) and the entry disappears again.
5. Close one window: the other sees the count drop, keeps the roster consistent, and
   clears the nearby entry immediately.
6. Stop the backend: both windows go to `error`/reconnecting; restart it and the
   sessions rejoin with fresh snapshots and an empty nearby list until someone walks up.

## 8. Limitations and follow-ups

* **No MongoDB in this environment** — the persistence path is verified against the
  double. Before trusting it in production, run the repository tests against a real
  MongoDB (the same suite would exercise the real `$near` plan) and re-measure §6 with
  `mongod` in the loop. This is the single largest open verification gap.
* **No browser in this environment** — canvas rendering is verified with a recording
  fake context (arcs, dashes, non-finite-argument guards), not visually. The ring's
  colours and the panel's layout deserve one human look (§7).
* The TTL index expires after 24 h; a longer history would need a separate append-only
  collection, since this one deliberately holds a single live record per session.
* `spatialCheck` compares at most one player every 30 s; it is a smoke alarm for
  strategy drift, not a full audit.
* WebRTC remained out of scope, as instructed.
