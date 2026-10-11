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
│   │   ├── sockets/handlers.js # socket event routing
│   │   ├── services/presence.js
│   │   ├── services/proximity.js
│   │   └── services/validation.js
│   └── package.json
├── .env.example
└── .gitignore
```

Rule: `world/`, `render/`, and `services/` are pure and unit-testable; `net/` (client) and `sockets/` (server) are the only I/O boundaries.

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

- Socket.IO wrapper (`net/socketClient.js`): connect, reconnect handling, event dispatch into the store, outbound throttling (position updates at 15 Hz).
- Connection states: `connecting → connected → disconnected`, exposed to the UI; Socket.IO default auto-reconnect with backoff; roster resync on reconnect.

## 5. Backend Architecture

- Express: health endpoint, static serving of `client/dist` in production, CORS (origin from env).
- Socket.IO: `path: /socket.io`, transports `["websocket", "polling"]`, CORS same-origin policy as Express.
- In-memory authoritative state: `Map<userId, { id, name, x, y, dir, moving, lastSeen, socketId }>`.
- Presence service: join/leave, roster broadcast, disconnect cleanup (single `disconnect` handler; no duplicate listeners).
- Proximity service: on each validated position update, recompute neighbors within PROXIMITY_RANGE (350 units) for the mover and affected neighbors; emit throttled `proximity:update` (≤ 5 Hz per client).
- Validation service: finite numbers, bounds check, max displacement per update (anti-teleport), name length/charset, per-socket rate limits.
- MongoDB: persistence only (never on the real-time path). Write position snapshots at low frequency (e.g., every 5 s per user) and on disconnect.

## 6. Socket.IO Event Contract

Client → Server:

| Event | Payload | Notes |
|-------|---------|-------|
| `session:join` | `{ name }` | name 1–24 chars |
| `position:update` | `{ x, y, dir, moving, clientTs }` | ≤ 15 Hz, validated |
| `signal:offer` | `{ targetId, sdp }` | relayed |
| `signal:answer` | `{ targetId, sdp }` | relayed |
| `signal:ice` | `{ targetId, candidate }` | relayed |

Server → Client:

| Event | Payload | Notes |
|-------|---------|-------|
| `session:welcome` | `{ id, name, world, users }` | initial roster + world meta |
| `user:joined` | `{ user }` | |
| `user:left` | `{ id }` | |
| `position:update` | `{ id, x, y, dir, moving, serverTs }` | |
| `proximity:update` | `{ nearby: [{ id, distance }] }` | ≤ 5 Hz |
| `signal:offer` / `signal:answer` / `signal:ice` | `{ from, ... }` | relayed |
| `app:error` | `{ code, message }` | recoverable errors |

Both sides treat unknown events as no-ops and validate every payload with hand-rolled validators (no extra validation library in v1).

## 7. Database Strategy (MongoDB Atlas)

- Official `mongodb` driver; single `MongoClient`, SRV connection string from `MONGODB_URI` env; retryWrites enabled.
- **Coordinate representation:** GeoJSON `Point { type: "Point", coordinates: [x, y] }` — world x stored as GeoJSON "longitude", y as "latitude". Planar approximation is valid because the world is small and we only need relative distances; `$maxDistance` is interpreted in the same units as the coordinates.
- Collections:
  - `users`: `{ _id, name, createdAt, lastSeenAt }`
  - `positionSnapshots`: `{ _id, userId, location (Point), ts }` with a `2dsphere` index on `location` and a TTL index on `ts` (e.g., 7 days).
- Spatial queries: `$near` / `$maxDistance` for "who was near X" analytics. Real-time proximity is computed in memory — the DB is never in the hot path.
- Failure handling: a DB outage must not break real-time. Persistence writes are fire-and-forget with error logging; the driver's topology monitoring handles reconnect.

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
