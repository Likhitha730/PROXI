# ProxiSpeak — System Architecture

**Status:** Design baseline for implementation
**Last updated:** 2026-10-11

## 1. Overview

```
[Browser A]   [Browser B]
     |  Socket.IO: presence, positions, proximity, WebRTC signaling
     v
[Express + Socket.IO server] --- [MongoDB Atlas]
     |
     +--- WebRTC signaling relay (SDP / ICE via Socket.IO)

[Browser A] <--- WebRTC P2P audio (proximity-filtered) ---> [Browser B]
```

Key principle: the server is authoritative for presence, positions, and proximity. Audio never touches the server — it is peer-to-peer.

## 2. Planned Repository Layout

```
ProxiSpeak/
├── docs/
├── client/                     # Vite + React frontend (port 5173)
│   ├── src/
│   │   ├── main.jsx            # React entry
│   │   ├── App.jsx             # Shell: canvas + HUD panels
│   │   ├── config/env.js       # typed access to import.meta.env
│   │   ├── world/              # PURE: world map data, collision, math (no DOM, no net)
│   │   ├── render/             # Canvas renderer, camera, avatar animation (no net)
│   │   ├── net/                # Socket.IO client wrapper, WebRTC manager, audio graph
│   │   ├── state/              # client-side world state store (local + remote merged)
│   │   ├── components/         # React HUD: nearby panel, connection badge, settings
│   │   └── styles/
│   ├── index.html
│   └── vite.config.js          # server: { port: 5173, strictPort: true }
├── server/
│   ├── src/
│   │   ├── index.js            # Express + Socket.IO bootstrap
│   │   ├── config/env.js       # env access with defaults and validation
│   │   ├── db/mongo.js         # official driver connect + index setup
│   │   ├── sockets/handlers.js     # presence protocol (join/move/disconnect)
│   │   ├── realtime/registry.js    # authoritative player table
│   │   ├── realtime/rateLimiter.js # token bucket for movement updates
│   │   └── db/mongo.js             # persistence (not enabled yet)
│   └── package.json
├── shared/
│   └── protocol.js             # ONE wire contract imported by client AND server
├── .env.example
└── .gitignore
```

Rule: `world/`, `render/`, `realtime/`, and `shared/` are pure and unit-testable;
`net/` (client) and `sockets/` (server) are the only I/O boundaries. Proximity and
signalling services land in `server/src/realtime/` in a later session.

## 3. World Model and Coordinate System

- Fixed logical world: **2560 × 1600 units**. 1 unit = 1 CSS px at zoom 1.
- Origin top-left, x → right, y → down (screen space). All game math happens in world space; screen space exists only at the final canvas transform.
- World data is declarative JSON: zones (rooms), walls/furniture as axis-aligned bounding boxes (AABBs), spawn points, and render-only decor (plants, rugs).
- Collision: avatar = circle (r = 16); obstacles = AABBs. Axis-separated movement (move x, resolve; move y, resolve) — cheap and stable.
- Camera: follows the local avatar with lerp smoothing; clamped to world bounds; zoom 0.5–2.0 via mouse wheel, zoom-to-cursor.

## 4. Frontend Architecture

### 4.1 Rendering (Canvas)

- Single `<canvas>`; `requestAnimationFrame` loop; delta time from `performance.now()`, clamped to 100 ms.
- Render order: floor/zones → furniture → decor → avatars (sorted by y for depth) → effects.
- Avatars: vector-drawn in v1, with 8-way directional walking and idle bob. Animation phase advances with distance traveled, not wall-clock, so speed changes look natural.
- Remote avatars: interpolation buffer (snapshots with server timestamps), rendered at `now − 120 ms`, linear interpolation between the two surrounding snapshots; extrapolation capped at 150 ms, then snap to latest.
- Local avatar: rendered immediately (no interpolation) for zero input latency.

### 4.2 State Separation

- `state/worldStore.js`: authoritative client-side model (users, positions, proximity). Mutated only by network events and local input.
- `render/` reads the store each frame; never subscribes to sockets.
- `net/` writes into the store; never touches the canvas.
- React HUD components read connection state and the nearby list via a small observable/selector layer (or `useSyncExternalStore`).

### 4.3 Network Client

- Socket.IO wrapper (`net/socketClient.js`): connect, reconnect handling, protocol wiring (join on connect, presence events in, movement out at ≤ 15 Hz). Listener binding is idempotent — a StrictMode remount or a reconnect can never double-subscribe.
- Connection states: `connecting → connected → disconnected → error`, exposed to the UI; Socket.IO auto-reconnect with backoff; a reconnect is a new server session, so the client clears stale presence and re-joins with its stored display name.
- Presence model (`net/presence.js`): owns remote players and separates two consumers — the canvas engine (interpolated positions, read every frame, no allocation) and the React HUD (a frozen snapshot that changes only on join/leave/rename/session events, **never** on movement).
- Remote motion (`render/interpolation.js`): samples are buffered and rendered `INTERPOLATION_DELAY_MS` (120 ms) in the past, interpolated between the bracketing samples, with bounded extrapolation (`EXTRAPOLATION_LIMIT_MS` 150 ms) when the stream stalls.

## 5. Backend Architecture

- Express: health endpoint, static serving of `client/dist` in production, CORS (origin from env).
- Socket.IO: `path: /socket.io`, transports `["websocket", "polling"]`, CORS same-origin policy as Express.
- In-memory authoritative state (`server/src/realtime/registry.js`): `Map<socketId, { player, socketId, lastPosition }>`. The player record is `{ id, name, x, y, dir, moving, joinedAt }`, frozen on write; `id` is a server-minted UUID — a client can never choose or reuse one.
- Presence service (`server/src/sockets/handlers.js`): join/rename/snapshot, roster broadcast, movement relay, disconnect cleanup (one `disconnect` handler per socket; listeners registered exactly once per connection). Identity and room membership are server-owned: any `id`/`room` field a client sends inside `player:join` is ignored.
- One socket can never create two players: a second `player:join` with a different name is a *rename* (same id, re-announced as an upsert); with the same name it is a no-op. The room is a single server-assigned lobby, capped at `MAX_PLAYERS_PER_ROOM` (24).
- Validation service (`shared/protocol.js`, used authoritatively by `server/src/sockets/handlers.js`): finite numbers, walkable-world bounds, max displacement per update (anti-teleport), name length/charset, `clientTs` skew. Rate limiting (`server/src/realtime/rateLimiter.js`) is a token bucket: `MOVE_UPDATES_PER_SECOND` (15) sustained with a small burst, checked *before* parsing. Rejected moves never mutate the registry and are answered with `server:error` (`invalid_position` carries the authoritative coordinates so the client can resync).
- Proximity service (`server/src/realtime/proximity.js`): a uniform spatial grid (cell size = radius) over **live registry state only**, queried as a 3x3 cell block — with 100 u cells that block is guaranteed to contain every possible neighbour, so the result is exact. Radius `LIMITS.PROXIMITY_RADIUS` (**100 world units**), published at most `PROXIMITY_UPDATES_PER_SECOND` (**4 Hz**) per client, recomputed only after `PROXIMITY_MIN_MOVEMENT` (**8 u**) of movement, with `PROXIMITY_HYSTERESIS` (**12 u**) keeping an existing neighbour until they leave radius + 12. Results are capped at `PROXIMITY_MAX_NEIGHBOURS` (16). On an accepted move the mover **and** every player whose range it may have entered or left are recomputed (`updateAffected`); joins and leaves force a full sweep immediately, so membership changes never wait for a throttle.
- Persistence (`server/src/db/*`): MongoDB is an archive, never a dependency of the real-time path. Positions are upserted per session at most once per `POSITION_FLUSH_MS` (default 2 s) plus once on join, the archive is marked on disconnect, stale records are pruned and expired by a TTL index, and every operation degrades to a logged `{ ok: false }` when the database is unavailable.

## 6. Socket.IO Event Contract

The wire contract lives in **`shared/protocol.js`**, imported by both `client/` and
`server/`, so an event name or payload shape cannot drift between the two sides.
Event names are namespaced by the entity they concern: `player:*`, `players:*`,
`server:*`. Unknown events are ignored (never an error) on both sides, and every
inbound payload is validated with hand-rolled validators (no validation library).

A "player" is always the full record:

```js
{ id, name, x, y, dir, moving, joinedAt }   // id is server-minted; dir in radians
```

Client → Server:

| Event | Payload | Notes |
|-------|---------|-------|
| `player:join` | `{ name }` | 1–24 characters after whitespace collapsing; `id`/`room` in the payload are ignored. Re-sending it renames (same player id) |
| `player:move` | `{ x, y, dir, moving, clientTs }` | ≤ 15 Hz, validated, `clientTs` skew ≤ 2 s |

Server → Client:

| Event | Payload | Notes |
|-------|---------|-------|
| `players:snapshot` | `{ version, self, players[], room, world, moveHz, serverTs }` | sent to the joiner only: its own record plus the existing roster |
| `player:joined` | `{ player }` | broadcast to the room; clients **upsert by id** (covers renames) |
| `player:moved` | `{ id, x, y, dir, moving, serverTs }` | the 15 Hz delta — only the fields that change |
| `player:left` | `{ id }` | on disconnect (transient state is dropped server-side) |
| `proximity:update` | `{ id, radius, neighbours[], at }` | the documented proximity result: nearest first, self excluded, deduplicated; each neighbour is `{ id, name, x, y, distance, nearby: true }`. Sent on join, when the neighbour set changes, and (at ≤ 4 Hz) when distances have moved enough to be worth redrawing |
| `server:error` | `{ code, message, data? }` | recoverable; `data` carries corrections (`{ x, y }` for `invalid_position`) |

Error codes: `invalid_name`, `invalid_payload`, `invalid_position`, `rate_limited`,
`room_full`, `join_required`, `internal_error`.

Authority rules: the registry is the single source of truth for positions; a
rejected update is answered with a correction and never broadcast; movement is
relayed only to the room (`socket.to(room)`) and never back to the sender.

## 7. Database Strategy (MongoDB Atlas)

Status: **implemented** (`server/src/db/`). MongoDB stores the archive of where
people have been; it is deliberately *not* on the real-time path.

- Official `mongodb` Node driver (6.x), one `MongoClient`, connection string from
  `MONGODB_URI` (never logged, never returned by any endpoint), database name from
  `MONGODB_DB`, collection from `MONGODB_COLLECTION` (default `positions`).
- **Coordinate representation: a planar pair, `location: [x, y]`, with a legacy `2d`
  index.** The office is a flat 2560 x 1600 pixel world, so the coordinates are *not*
  longitude/latitude: GeoJSON + `2dsphere` would interpret them as degrees on a
  sphere (metric distances, converging meridians) and reject any `y > 90`, which this
  world exceeds by an order of magnitude. A `2d` index treats the pair as a plane and
  answers distances in the same world units.
- Index bounds: `2d` index with `min: 0, max: 2560` (a `2d` index range is square, so
  the bound must cover the longer axis; the world's y range simply occupies the lower
  part of it).
- Collection `positions`, one live document per session:

  ```js
  {
    sessionId: "<server-minted player uuid>",  // unique: one live record per session
    name: "Ada",
    location: [x, y],                          // planar pair, 2d-indexed
    connected: true,                           // false after the session ends
    schemaVersion: 1,
    firstSeenAt: Date,
    updatedAt: Date
  }
  ```

- Indexes, created idempotently at startup (`server/src/db/indexes.js`): `location_2d`
  (`2d`, 0-2560), `sessionId_unique` (unique — enforces one record per session under
  concurrent upserts) and `updatedAt_ttl` (TTL, 24 h). Existing indexes are inspected
  first: identical ones are left alone, an existing index with the same key but
  different options is reported as a conflict and **never dropped automatically**, and
  driver errors (including `NamespaceNotFound` 26 and `IndexAlreadyExists` 68) are
  logged, never fatal.
- Queries (`server/src/db/positions.js`):
  - `{ location: { $near: [x, y], $maxDistance: r } }` — ascending planar distance in
    world units, filtered by `connected: true`, a freshness window on `updatedAt`, and
    `sessionId: { $ne: self }`;
  - `{ location: { $geoWithin: { $center: [[x, y], r] } } }` for area reads.
  - `findNearby` optionally intersects the result with the *live* session id set, so an
    archive row can never masquerade as an active user.
- Live presence is always the in-memory registry. A slow consistency check
  (`server/src/realtime/spatialCheck.js`, every 30 s) compares the database `$near`
  result with the in-memory grid at the most recently active player and logs any
  disagreement, noting that the archive lags by up to one flush interval.
- Failure handling: every database call is wrapped; a missing connection, a timeout or
  a rejected operation returns `{ ok: false, reason: 'database unavailable' }`, is
  counted in `stats.persistFailures` and never propagates into a socket handler.
- Measured behaviour: see `docs/SESSION_05_REPORT.md` §6 and
  `scripts/bench-proximity.mjs`. **No MongoDB performance is claimed anywhere**: this
  environment has no `mongod`, so the database code path is exercised against the
  in-process double `server/src/test/fakeMongo.js`, and the numbers published for it
  are that double's numbers.

## 8. WebRTC Signaling Flow

1. Client receives `proximity:update`; for each user entering AUDIO_RANGE (450 units) without an existing peer → create `RTCPeerConnection`, create offer, send `signal:offer { targetId, sdp }`.
2. Target receives offer → `setRemoteDescription` → `createAnswer` → `signal:answer`.
3. Both sides exchange `signal:ice` candidates (trickle).
4. `ontrack` → attach the `MediaStream` to the Web Audio graph (not to an `<audio>` element).
5. When distance > AUDIO_RANGE + hysteresis (50 units) or the user leaves → close the peer connection and disconnect audio nodes.
6. ICE servers: STUN only in v1 (TURN is a documented risk for symmetric NATs).
7. Mic: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` once per session; denial → UI state "audio disabled"; proximity and panels still work.

## 9. Spatial Audio Graph (Web Audio API)

Per remote peer:

```
MediaStreamAudioSourceNode → GainNode (distance) → StereoPannerNode → destination
```

- `gain = clamp(1 − d / AUDIO_RANGE, 0, 1) ^ 1.5`, updated on each `position:update` (throttled to animation frames).
- `pan = clamp(relativeX / AUDIO_RANGE, −1, 1)` where `relativeX = peer.x − local.x` (screen-space x).
- The local mic is NOT routed to speakers (avoids feedback); only remote streams are rendered.
- `AudioContext` is resumed on the first user gesture (browser autoplay policy).

## 10. Security Risks

- Unvalidated coordinates → anti-teleport + bounds checks (server).
- Event flooding → per-socket rate limits on `position:update` and signaling events.
- Secrets → `MONGODB_URI`, `CORS_ORIGIN` via env; `.env` gitignored; `.env.example` documents keys without values.
- XSS via display names → React escapes by default; canvas `fillText` is safe; still sanitize length/charset.
- WebRTC permission errors → graceful degradation.
- No auth in v1 → impersonation is possible; accepted risk, auth planned for a later session.

## 11. Test Strategy

- **Unit (Vitest):** world math, collision, interpolation, proximity math, validation, gain/pan formulas.
- **Integration:** Socket.IO handlers with `socket.io-client` in-memory; join/move/leave/proximity flows; disconnect cleanup.
- **Manual E2E checklist** (two tabs + two machines): movement, collision, interpolation, proximity panel, audio connect/disconnect, pan/attenuation, reconnect, mic denial.
- No feature is claimed "working" until its acceptance criteria are executed and observed.

## 12. Deployment Plan (later session)

- Build `client` → `client/dist`; Express serves it in production (single origin, no CORS needed).
- Env: `PORT` (default 8080), `MONGODB_URI`, `CORS_ORIGIN`, `NODE_ENV`.
- Process management: PM2 or a container; health endpoint `/healthz`; MongoDB Atlas IP allowlist; TLS termination at the platform.
- Scaling path (future): rooms, sticky sessions / Redis adapter if multi-instance.
