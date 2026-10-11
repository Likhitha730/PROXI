# ProxiSpeak — Development Plan

**Last updated:** 2026-10-11
**Scope of this session:** documentation only (this file, PROJECT_REQUIREMENTS.md, ARCHITECTURE.md, .gitignore). No application code, no dependency installation.

## Guiding Rules

- Small, testable modules; rendering strictly separated from network state.
- JavaScript only; no TypeScript; no unnecessary libraries.
- Nothing is "done" until its acceptance criteria are executed and observed.
- Frontend dev server: Vite port 5173 with `strictPort: true` — fail loudly if the port is occupied.

## Phase 0 — Scaffolding ✅ (completed 2026-10-12, Session 1 implementation)

> Session 1 implementation also delivered the first working vertical slice (application shell +
> health endpoint + Socket.IO handshake). See [SESSION_02_REPORT.md](./SESSION_02_REPORT.md).
> Verification note: the folder structure, package files, `vite.config.js` and `.env.example` files
> now exist, dependencies are installed, and `npm run dev` runs both servers (failing loudly when
> port 5173 is occupied) — all Phase 0 acceptance criteria are executed and observed.
> Lint tooling is configured (`npm run lint`) and tests run via `npm test`.

Tasks:

1. Create folder structure per ARCHITECTURE.md §2 (`client/`, `server/`, `docs/`).
2. Root `package.json` (simple scripts; no workspaces tooling in v1).
3. `client/package.json`: React, React DOM, Vite, `@vitejs/plugin-react`, Socket.IO client.
4. `server/package.json`: Express, Socket.IO, `mongodb` (official driver), `dotenv`.
5. `client/vite.config.js` with `server: { port: 5173, strictPort: true }` and proxy `/socket.io` → backend in dev.
6. `.env.example` on both sides documenting every key (no values).

Acceptance criteria:

- `npm run dev` (client) serves on http://localhost:5173 and fails with a clear error if the port is taken.
- `npm run dev` (server) starts Express + Socket.IO and logs readiness.
- `.env.example` exists; `.env` is gitignored.
- Folder structure matches ARCHITECTURE.md §2.

## Phase 1 — World Rendering (Canvas)

Tasks: world data JSON (zones, walls, furniture, decor); camera (follow, clamp, zoom-to-cursor); rAF loop with delta time; render pipeline floor → furniture → decor.

Acceptance criteria: office renders at 60 fps; zoom 0.5–2.0 works; camera never shows outside world bounds (letterboxed).

## Phase 2 — Local Avatar

Tasks: keyboard input (WASD/arrows); delta-time movement; circle-vs-AABB collision; directional walking + idle animation (vector-drawn avatar).

Acceptance criteria: smooth 60 fps movement; avatar cannot leave bounds or cross walls; animation direction matches movement direction.

## Phase 3 — Presence & Movement Sync (Socket.IO)

Tasks: server presence service (join/leave, in-memory state, validated position broadcast, disconnect cleanup); client socket wrapper; world store; remote avatar interpolation (120 ms buffer).

Acceptance criteria: two tabs — remote avatar moves smoothly; disconnect removes the avatar and cleans all server state; no duplicate listeners; no stale user records.

## Phase 4 — Proximity Detection

Tasks: server proximity service (350 units, throttled `proximity:update`); client nearby-users panel (React HUD) with names and distances.

Acceptance criteria: panel updates ≤ 5 Hz; lists exactly the users within range; displayed distances match measured world distance.

## Phase 5 — WebRTC Audio + Spatial Audio

Status: **voice implemented** (see [SESSION_06_REPORT.md](./SESSION_06_REPORT.md)); the
spatial-audio half is **not** implemented. The listening radius is 100 units (not the
450 units this plan originally guessed), with 12 units of hysteresis.

Implemented: proximity-filtered peer connections, server-authorized signalling relay
with server-derived sender identity, per-session signalling rate limits, STUN/TURN
configuration served from `/api/ice`, microphone consent on an explicit user action,
mute, speaking/connection indicators, and teardown on revocation, hang-up or disconnect.

Not implemented (deliberately deferred): the Web Audio graph — distance gain and stereo
panning. Every call currently plays at full volume; `docs/ARCHITECTURE.md` §9 is marked
as a design note for a later session.

Acceptance criteria met: voice connects only within range; teardown on exit or when the
listening radius is left; mic denial (and missing device, missing WebRTC) degrades
gracefully with a clear UI state. Deferred: volume and pan following position, which
depends on the unimplemented audio graph.

## Phase 6 — Persistence, Polish, Verification

Tasks: MongoDB Atlas integration (`users`, `positionSnapshots` with `2dsphere` + TTL indexes, low-frequency writes); connection-state UI; error toasts; rate limiting; final security review; full manual E2E checklist executed and recorded.

Acceptance criteria: all v1 acceptance criteria in PROJECT_REQUIREMENTS.md §6 pass; no console errors; DB writes verified in Atlas.

## Later Sessions (explicitly not started here)

- Git repository initialization and production deployment.
- Authentication, TURN infrastructure, multi-room support, text chat.

## Definition of Done (per phase)

1. Acceptance criteria executed and observed.
2. No new lint errors (linting configured in Phase 0).
3. Docs updated if the design changed.

## Exact Next Implementation Step

Phase 0, task 1–2: create the folder structure (`client/`, `server/`) and the root `package.json`, then `client/package.json` (Vite + React + Socket.IO client) and `server/package.json` (Express + Socket.IO + mongodb), plus `client/vite.config.js` with `server: { port: 5173, strictPort: true }` and `.env.example`. Then verify both dev servers start. No application logic in that step.

## Session Log

- **Session 0 (2026-10-12) — Documentation baseline: complete and verified.** Requirements, architecture,
  development plan and `.gitignore` are in place and cover every required topic; no application code
  written and no dependencies installed. Findings and open decisions are recorded in
  [SESSION_01_REPORT.md](./SESSION_01_REPORT.md).
- **Session 1 (2026-10-12) — Phase 0 + application shell: complete, verified.** React/Vite shell on port
  5173 (strictPort), Express + Socket.IO on 8080 attached to one HTTP server, `GET /api/health`,
  explicit `CORS_ORIGIN` allow-list, safe connect/disconnect logging, MongoDB placeholders, graceful
  shutdown, npm scripts for dev/build/start/lint/test/smoke. 39 automated tests pass, lint is clean,
  and all manual checks (frontend load, health, browser-path Socket.IO, port-conflict failure,
  production serving, shutdown) were executed. See [SESSION_02_REPORT.md](./SESSION_02_REPORT.md).
  Next: Phase 1 — Canvas world rendering and camera.
