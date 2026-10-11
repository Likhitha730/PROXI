# ProxiSpeak

A premium, real-time virtual office. Users control animated avatars in a polished 2D office rendered on
HTML5 Canvas; when avatars come within earshot, a WebRTC audio channel opens automatically and voices
are rendered with distance-based volume and stereo panning.

> **Current milestone — Session 1: application shell.**
> React/Vite frontend shell, Express + Socket.IO backend, health endpoint, CORS allow-list, safe
> connection logging, MongoDB integration placeholders and graceful shutdown.
> Avatar movement, world rendering, presence/proximity, MongoDB geospatial queries and WebRTC are
> **not implemented yet** — see [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md).

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite (dev port **5173**, `strictPort: true`) |
| Realtime | Socket.IO (WebSocket with polling fallback) |
| Backend | Node.js 20+ · Express 4 |
| Database | MongoDB Atlas via the official `mongodb` driver (optional in this milestone) |
| Audio (later) | WebRTC transport · Web Audio API spatial graph |
| World (later) | HTML5 Canvas 2D, custom renderer |

## Requirements

- Node.js **20 or newer** (`node -v`)
- npm 10+
- No database is required to run or verify this milestone.

## Install

```bash
npm install                 # root dev tooling (eslint, socket.io-client for the smoke test)
npm --prefix client install # React, Vite
npm --prefix server install # Express, Socket.IO, mongodb, dotenv
```

## Run

```bash
npm run dev          # backend (8080) + frontend (5173) together, prefixed logs
npm run dev:server   # backend only
npm run dev:client   # frontend only
```

- Frontend: <http://localhost:5173>
- Health: <http://localhost:8080/api/health>
- The frontend dev server **fails loudly** if 5173 is already in use — it never silently switches ports.
- The browser talks only to port 5173; Vite proxies `/api` and `/socket.io` (WebSocket upgrade included)
  to the backend, so no cross-origin request is made in development. `BACKEND_ORIGIN` overrides the
  proxy target.

## Verify

```bash
npm run smoke:socket                                        # direct to the backend
SMOKE_URL=http://127.0.0.1:5173 npm run smoke:socket        # through the Vite proxy (browser path)

npm run verify:multiplayer                                  # two scripted clients: presence + proximity
npm run verify:audio                                        # two scripted clients: real WebRTC audio (needs the server running)
node scripts/bench-proximity.mjs                            # proximity/engine measurements, honestly labelled

npm run lint         # eslint over client, server and scripts
npm test             # client unit tests + server unit/integration tests (Vitest, no DB needed)
npm run build        # production build of the client into client/dist
```

`npm test` needs no MongoDB: the persistence code path is covered against the in-process
double in `server/src/test/fakeMongo.js` (documented in `docs/ARCHITECTURE.md` §7 and
`docs/SESSION_05_REPORT.md`).

`npm run build && NODE_ENV=production npm start` serves the built frontend and the API from the single
Express origin on port 8080.

## Environment variables

Nothing is required: every variable has a documented local-development default. Copy the example files
to create real ones — `.env` files are gitignored and must never be committed.

| File | Key | Default | Purpose |
|------|-----|---------|---------|
| `server/.env` | `PORT` | `8080` | HTTP/Socket.IO port |
| `server/.env` | `HOST` | `0.0.0.0` | Bind interface |
| `server/.env` | `NODE_ENV` | `development` | Mode (`production` serves `client/dist`) |
| `server/.env` | `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated CORS allow-list (`*` is an explicit opt-in) |
| `server/.env` | `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `server/.env` | `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful-shutdown budget |
| `server/.env` | `MONGODB_URI` | *(empty)* | Atlas connection string; empty ⇒ persistence disabled, health still `ok` |
| `server/.env` | `MONGODB_DB` | `proxispeak` | Database name |
| `server/.env` | `MONGODB_COLLECTION` | `positions` | Collection holding one live record per session |
| `server/.env` | `PROXIMITY_RADIUS` | `100` | Proximity listening radius, world units (1–2000) |
| `server/.env` | `POSITION_FLUSH_MS` | `2000` | Max write rate per session to MongoDB (250–60000 ms) |
| `server/.env` | `ICE_STUN_URLS` | `stun:stun.l.google.com:19302` | STUN servers handed to browsers at `GET /api/ice` (comma-separated) |
| `server/.env` | `ICE_TURN_URL` | *(empty)* | Optional TURN relay (`turn:` / `turns:` only). Empty ⇒ no relay |
| `server/.env` | `ICE_TURN_USERNAME` | *(empty)* | TURN credential username — a secret, server-side only |
| `server/.env` | `ICE_TURN_CREDENTIAL` | *(empty)* | TURN credential password — a secret, server-side only |
| `client/.env` | `VITE_SOCKET_URL` | *(empty = same origin)* | Backend Socket.IO URL |
| `client/.env` | `VITE_API_URL` | *(empty = same origin)* | Backend REST base URL |
| `client/.env` | `VITE_APP_NAME` | `ProxiSpeak` | Header product name |
| `client/.env` | `VITE_ICE_STUN_URLS` | *(empty)* | Development-only ICE override; normally leave empty and let `GET /api/ice` decide |
| `client/.env` | `VITE_ICE_TURN_URL` | *(empty)* | Development-only TURN override. **Never a real credential** — see below |
| `client/.env` | `VITE_ICE_TURN_USERNAME` | *(empty)* | Development-only TURN username |
| `client/.env` | `VITE_ICE_TURN_CREDENTIAL` | *(empty)* | Development-only TURN password |

`client/.env.example` and `server/.env.example` contain placeholders only — never real credentials.
`VITE_*` values are inlined into the browser bundle, so they must never hold secrets. That is why TURN
credentials belong in `server/.env` (served at runtime from `GET /api/ice`) and **not** in `VITE_ICE_*`,
which exist only as a local development convenience.

## Voice (proximity audio)

When two avatars come within the listening radius (100 world units, 12 units of hysteresis once a call
is up) **and both have switched their microphone on**, the server authorizes the pair and the two
browsers open a direct `RTCPeerConnection` between themselves. Audio never passes through the backend:
it only relays SDP and ICE. Walking out of earshot, muting, hanging up or disconnecting closes the
connection and releases the microphone and every audio element.

* The microphone is requested **only** when you press **Enable microphone** — never on load, never on
  join. Denied permission, a missing device or a browser without WebRTC each show a clear state and
  leave the rest of the app working.
* **Mute** stops sending audio without tearing the call down; the peer sees a `muted` badge.
* The **Voice** panel shows the microphone state in words, one row per voice connection with
  speaking/connecting state, and the listening radius in use.

### Connectivity and TURN

STUN is configured server-side (`ICE_STUN_URLS`) and served to browsers at `GET /api/ice`; the client
falls back to a public STUN server when that endpoint is unreachable. **STUN alone is not always
enough**: peers behind symmetric NATs, corporate firewalls or networks that block UDP need a **TURN
relay** to connect. Configure one with `ICE_TURN_URL`, `ICE_TURN_USERNAME` and `ICE_TURN_CREDENTIAL`
in `server/.env` (never committed); `GET /api/ice` then reports `hasTurn: true`, and the panel says so
when a connection fails. Without a relay, calls still work on localhost, a LAN, and most home networks.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api` | Service metadata + endpoint list |
| `GET` | `/api/health` | Liveness/readiness JSON. Secrets and environment values are never included. |
| `GET` | `/api/ice` | ICE configuration for browsers: `{ iceServers, hasTurn, ttlSeconds }`, `Cache-Control: no-store`. TURN credentials are served here at runtime rather than built into the bundle. |
| `GET` | `/socket.io/...` | Socket.IO handshake (WebSocket + polling) |

`/api/health` response shape:

```json
{
  "status": "ok",
  "service": "proxispeak-server",
  "version": "0.1.0",
  "environment": "development",
  "uptimeSeconds": 12.4,
  "startedAt": "2026-10-12T00:00:00.000Z",
  "timestamp": "2026-10-12T00:00:12.400Z",
  "database": { "status": "disabled", "message": "no connection string configured" },
  "realtime": { "socketio": true, "path": "/socket.io" }
}
```

`database.status` is one of `disabled` · `connecting` · `connected` · `error` — a database outage never
breaks the realtime server, and recovery is handled by the driver's topology monitoring.

## Project structure

```
PROXI/
├── client/                     # Vite + React frontend
│   ├── src/
│   │   ├── main.jsx            # React entry
│   │   ├── App.jsx             # shell: header + workspace + footer + status overlay
│   │   ├── config/env.js       # validated import.meta.env access (defaults documented)
│   │   ├── components/         # header, connection badge, workspace, overlay, footer
│   │   ├── net/socketClient.js # the only socket owner: lifecycle → connectionStore
│   │   ├── state/              # connectionStore (observable) + React hooks
│   │   ├── world/math.js       # pure helpers for the upcoming world engine
│   │   └── styles/global.css   # local design system, no external assets
│   ├── .env.example
│   └── vite.config.js          # port 5173 strictPort, /api + /socket.io proxy
├── server/                     # Express + Socket.IO backend
│   ├── src/
│   │   ├── index.js            # bootstrap, Socket.IO wiring, graceful shutdown
│   │   ├── app.js              # Express app factory (+ static serving in production)
│   │   ├── config/env.js       # validated, frozen config; fail-loud parsing
│   │   ├── lib/logger.js       # dependency-free JSON logger with redaction
│   │   ├── middleware/http.js  # CORS allow-list, JSON 404, error handler
│   │   ├── routes/health.js    # GET /api/health
│   │   ├── sockets/handlers.js # connection/disconnection logging only
│   │   └── db/mongo.js         # Atlas connection placeholder (optional)
│   ├── .env.example
│   └── package.json
├── scripts/
│   ├── dev.mjs                 # runs client + server together with prefixed logs
│   └── smoke-socket.mjs        # health + Socket.IO handshake smoke test
├── docs/                       # requirements, architecture, development plan
└── eslint.config.js
```

Architectural rules kept in this milestone: `world/` and `render/` stay pure, `net/` is the only
client-side I/O boundary, `state/` holds the observable model, and Socket.IO/Express code is the only
server-side I/O boundary.

## Session 1 verification

Executed results are recorded in [`docs/SESSION_02_REPORT.md`](docs/SESSION_02_REPORT.md).

## Roadmap

| Milestone | Content | Status |
|-----------|---------|--------|
| Session 0 | Requirements, architecture, development plan | done |
| Session 1 | App shell, backend health + socket, tooling | done |
| Phase 1 | Canvas world rendering, camera | done |
| Phase 2 | Local avatar, keyboard movement, collision | done |
| Phase 3 | Presence + movement sync, remote interpolation | done |
| Phase 4 | Proximity detection, nearby panel | done |
| Phase 5 | WebRTC voice (proximity-gated, peer-to-peer) | done — see `docs/SESSION_06_REPORT.md` |
| Phase 5b | Spatial audio: distance gain + stereo panning | **not implemented** (deferred) |
| Phase 6 | MongoDB persistence, polish, E2E verification | done (persistence: `docs/SESSION_05_REPORT.md`) |

Per-session detail lives in `docs/SESSION_0*_REPORT.md`; each report states what was verified and what
could not be verified in the environment it ran in.
