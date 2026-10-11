# Session 4 Report — Multiplayer Server (presence, movement sync, interpolation)

Branch: `arena/6e75ac98-proxi` · Scope: **the prompt named "Session 3: the multiplayer server"**

The office from the previous session is untouched visually; it is now shared. Two
browser sessions see each other, move in both directions, and disappear cleanly on
disconnect. The server is authoritative over every coordinate it accepts.

Explicitly **not** in this session: MongoDB persistence, WebRTC audio.

---

## 1. One wire contract, imported by both sides

`shared/protocol.js` (new, 264 lines) is the single source of truth: event names,
payload shapes, numeric limits, validators and factories. Both packages import it,
so the client and server **cannot drift** — renaming an event is a one-line change.

Event names are namespaced by entity: five `player:*`, one `players:*`, one `server:*`.

| Direction | Event | Payload |
| --- | --- | --- |
| C → S | `player:join` | `{ name }` |
| C → S | `player:move` | `{ x, y, dir, moving, clientTs }` |
| S → C | `players:snapshot` | `{ version, self, players[], room, world, moveHz, serverTs }` |
| S → C | `player:joined` | `{ player }` (upsert by id — also covers renames) |
| S → C | `player:moved` | `{ id, x, y, dir, moving, serverTs }` |
| S → C | `player:left` | `{ id }` |
| S → C | `server:error` | `{ code, message, data? }` |

A player record is always `{ id, name, x, y, dir, moving, joinedAt }`. `docs/ARCHITECTURE.md`
§6 was rewritten to this contract (tables, payload schemas, error codes, authority rules),
and §5 now describes the registry/validation/rate-limiting that actually exists.

## 2. Server

| Module | Lines | Responsibility |
| --- | --- | --- |
| `server/src/realtime/registry.js` | 118 | Authoritative table keyed by socket id: server-minted UUID, display name, validated x/y, facing, movement state, connection timestamp, last accepted position (anti-teleport baseline). Records are frozen; the only way a position changes is `move()` after validation. |
| `server/src/realtime/rateLimiter.js` | 47 | Token bucket: 15 updates/s sustained, burst 5, checked before parsing payloads. |
| `server/src/sockets/handlers.js` | 248 | Join/rename/snapshot, movement relay, disconnect cleanup, validation wiring, error reporting. |
| `shared/protocol.js` | 264 | Contract + validators (`normaliseName`, `validateMove`, `isInsideWorld`) + spawn selection. |

Behaviour, all enforced server-side:

* **New user** → validated spawn point (the one farthest from everyone already in the
  room) plus `players:snapshot` containing its own record and the existing roster.
* **Existing users** → `player:joined` broadcast to the room.
* **Validated movement** → relayed to the room only, never echoed to the sender.
* **Authority** → rejected updates never touch the registry; `invalid_position` is
  answered with the authoritative `{ x, y }` so the client snaps back.
* **Disconnect** → registry entry and per-socket bucket dropped, `player:left` broadcast.
* **No duplicate registrations** → one socket can never create two players: a second
  `player:join` is a rename (same id, upsert) or a no-op.
* **No duplicate listeners** → listeners are registered once per connection; one
  `disconnect` handler per socket.
* **Rate limiting** → 15/s + burst; the warning is throttled to one per second; a socket
  that keeps sending garbage is disconnected after 40 invalid payloads.
* **Rejects** → malformed coordinates, `Infinity`/`NaN`, wrong types, values outside the
  walkable world, teleport-sized jumps (> walk speed for the elapsed time + slack),
  future `clientTs`, and invalid display names (empty, > 24 chars, control characters,
  markup, emoji, leading separators).
* **Identity/room are never trusted** → `id`, `room`, `roomId` inside `player:join` are
  ignored; the room is a single server-assigned lobby capped at 24 players.

## 3. Client integration

* `client/src/net/socketClient.js` (218) — joins on connect (and after every reconnect),
  forwards the five server events into presence, publishes movement at ≤ 15 Hz, stores
  the display name locally. Listener binding is idempotent: repeated `connect()` calls or
  a StrictMode remount cannot double-subscribe.
* `client/src/net/presence.js` (250) — the bridge with two deliberately different views:
  * **canvas (hot path)**: `collectPeers(now)` returns the *same* peer objects every
    frame with interpolated positions — no React, no per-frame allocation;
  * **React (cold path)**: a frozen snapshot that changes only on join/leave/rename/session
    events. Movement never rebuilds it, so the component tree does not re-render per move.
  It also exposes server corrections for the engine to drain.
* `client/src/render/interpolation.js` (158) — renders remote players 120 ms in the past,
  interpolating between the samples that bracket that moment, with bounded extrapolation
  (150 ms) and a "stale" flag when the stream goes quiet.
* `client/src/render/engine.js` — three optional callbacks keep the engine network-free:
  `setPeerProvider` (per-frame peers), `setStateReporter` (≤ 15 Hz local movement),
  `setCorrectionSource` (authoritative snap-back). Remote avatars get deterministic
  appearance, walk cycle advanced by real travel, and are dropped on `destroy()`.
* `client/src/components/PresencePanel.jsx` (103) — connected-user count, room id, editable
  display name (Enter/Apply → rename over the wire, persisted locally), roster list and
  server-error display with dismiss.
* Header chip and stage header now show the live count next to the connection status.

## 4. Commands I ran (actual results)

| Command | Result |
| --- | --- |
| `npm --prefix client test` | **200 passed / 200**, 15 files |
| `npm --prefix server test` | **70 passed / 70**, 7 files (was 29) |
| `npx eslint .` | clean |
| `npm run build` | 90 modules → 273.95 kB JS (88.05 kB gz), CSS 10.83 kB (3.12 kB gz) |
| `node scripts/verify-multiplayer.mjs` (via Vite proxy) | **10/10 checks passed** |
| `SMOKE_URL=http://127.0.0.1:8080 node scripts/verify-multiplayer.mjs` | **10/10 checks passed** |
| `node scripts/smoke-socket.mjs` | 5/5 (health, CORS, handshake, clean disconnect) |
| `GET /api/health` | 200, unchanged contract |

New test coverage:

| File | Tests | What it proves |
| --- | --- | --- |
| `server/src/sockets/presence.test.js` | 16 | Real two-client integration: snapshot, join notification, bidirectional movement, join-required, malformed/hostile payload rejection, teleport rejection + correction, 15 Hz cap, unknown events ignored, duplicate join is a rename/no-op, capacity limit, disconnect cleanup, no announcements for lurking sockets |
| `server/src/realtime/protocol.test.js` | 13 | Event set pinned (7 namespaced events), protocol numbers match the map data, name validation, position validation | 
| `server/src/realtime/registry.test.js` | 8 | Identity minting, no double registration, rename keeps identity, spawn spreading, frozen records |
| `server/src/realtime/rateLimiter.test.js` | 4 | Burst, sustained refill, clock-jitter safety |
| `client/src/net/socketClient.test.js` | 11 | One socket, one listener per event, join on connect/reconnect, event → presence wiring, movement payloads, name persistence, teardown |
| `client/src/net/presence.test.js` | 14 | Roster/count, upsert renames, **30 movement events cause zero subscriber notifications**, interpolation hand-off, reused objects, deterministic appearance, corrections, reset |
| `client/src/render/interpolation.test.js` | 11 | Delay-based interpolation, smoothness across 15 Hz samples, bounded extrapolation, out-of-order rejection, **no NaN with a missing clock** |
| `client/src/components/PresencePanel.test.jsx` | 7 | Count/roster/empty state, name applied through the network layer + persisted, error dismiss, disabled while disconnected, **typing in the name field does not move the avatar**, header count |
| `client/src/components/WorldCanvas.test.jsx` (extended) | +5 | Remote avatar appears from the roster, glides between network updates, leaves on `player:left`, local avatar snaps to the server correction, movement published through the socket layer |
| `client/src/render/engine.test.js` (extended) | +9 | Provider reconciliation per frame, appearance stability, ≤ 15 Hz reporting, silent while idle, corrections applied once, rename, peers dropped on destroy |

## 5. Manual verification — two browser sessions

The honours-the-requirement procedure, using separate browser sessions (private windows
or two browser profiles) so they do not share `localStorage` or a socket:

1. Start everything: `npm run dev` (backend on 8080, client on 5173).
2. Open **http://localhost:5173** in a normal window. Open the same URL in a **private
   window** (or a second browser/profile).
3. In each window, set a distinct display name in the HUD **Players** panel
   (*Display name* → **Apply**) — e.g. `Alice` and `Bob`.
4. Verify, in this order:
   * **Both appear**: each window shows `2 in the office`, the other name in the roster,
     the header chip reads `2 online`, and a second avatar with a name label stands in
     the office (spawned at a different point — the entrance and the meeting room).
   * **Movement syncs in both directions**: walk with WASD in window A and watch the
     avatar move smoothly in window B; repeat the other way round.
   * **Counts are correct**: `1 online` before the second window joins, `2 online` after,
     back to `1 online` when one closes.
   * **Disconnect removes the player**: close one window (or hit reload) — the avatar
     disappears from the other window and the count drops immediately.
   * **Jitter**: remote avatars glide; they never teleport per network packet. If you
     throttle the network (DevTools → Network → Slow 3G) the avatar keeps moving for a
     moment, then holds its last position instead of flying off.
   * **Server authority**: in DevTools, emit a teleport from the console
     (`window.__proxiDebug?.teleport()`, or watch the network tab) — the server answers
     with an error and the avatar snaps back to where the server last saw it.
   * **Typing is safe**: click into the display-name field and type/mash WASD — the
     avatar must not move while the field has focus.
5. Optional: `curl -s localhost:8080/api/health` shows the backend, and the backend log
   prints `player joined` / `player left` with the live player count.

**Scripted equivalent of steps 3–4** (runs headless, against the live stack, through the
Vite proxy exactly like a browser):

```bash
node scripts/verify-multiplayer.mjs
```

## 6. Bugs found and fixed while verifying

1. **NaN avatar coordinates** — the engine called the peer provider without a timestamp,
   so interpolation sampled with `undefined`, produced `NaN`, and `ctx.translate(NaN, NaN)`
   threw (caught by the recording fake canvas). Fixed at four levels: the engine now passes
   its frame clock, the motion buffer falls back to its newest sample and never emits
   non-finite values, presence defaults to its own clock, and the fake rAF now uses the real
   time base so animation and network clocks are comparable. Regression test added.
2. **Rate limiter ordering** — a burst of *malformed* payloads can come back `rate_limited`
   rather than `invalid_payload`, because the bucket is checked before parsing (deliberate:
   cheap CPU protection). The integration test now asserts both outcomes instead of assuming
   validation always wins.
3. **Test harness modelling socket.io as synchronous** — the fake's `connect()` fired
   `'connect'` immediately, which hid the real ordering. The fake now models the async
   handshake (`simulateConnect()`), which is why the listener-count and join-once tests are
   meaningful.
4. **Verification script race** — waiting for `'connect'` after it had already fired; the
   script now awaits readiness explicitly before joining. Also fixed a check that counted a
   legitimate pre-disconnect broadcast as a stray update.
5. **`localStorage` spy on jsdom's Storage proxy** — replaced with behavioural assertions
   (the name really is stored and really is used).

## 7. Files

**Added (12):** `shared/protocol.js` · `server/src/realtime/{registry,rateLimiter}.js` +
tests · `server/src/realtime/protocol.test.js` · `server/src/sockets/presence.test.js` ·
`client/src/net/{presence.js,presence.test.js,socketClient.test.js}` ·
`client/src/render/interpolation.js` + test · `client/src/components/PresencePanel.jsx` +
test · `scripts/verify-multiplayer.mjs`

**Changed (14):** `server/src/sockets/handlers.js` (rewritten) · `server/src/index.js`
(owns the registry) · `client/src/net/socketClient.js` (protocol wiring) ·
`client/src/render/engine.js` (three network hooks, peer walk cycle) ·
`client/src/components/{WorldCanvas,Workspace,AppHeader}.jsx` · `client/src/App.jsx` ·
`client/src/state/hooks.js` (`usePresence`) · `client/src/styles/global.css` (presence panel,
header chip) · `client/src/test/fakeCanvas.js` (real time base) ·
`client/src/render/engine.test.js`, `client/src/components/WorldCanvas.test.jsx` (extended) ·
`docs/ARCHITECTURE.md` (§5, §6, structure)

## 8. Known limitations (next session's work)

* **No proximity filtering** — movement is relayed to the whole room. The documented
  `PROXIMITY_RANGE` (350) / `AUDIO_RANGE` (450) filtering arrives with the audio sessions;
  the presence model already carries `nearby`/`distance` slots for it.
* **No persistence** — presence lives in memory only (a restart empties the office).
  MongoDB writes stay out of scope this session, as instructed.
* **No WebRTC audio** — no signalling events, no `getUserMedia`; `server:error` and the
  peer record are ready for `signal:*` events.
* **Single room** — one server-assigned lobby; no multiple floors/rooms yet.
* **No chat, no avatars customisation UI** (appearance is deterministic from the player id).
* Manual browser verification was performed by script against the live stack (two real
  Socket.IO sessions through the Vite proxy): this sandbox has no browser binaries, so
  steps 1–5 above remain the checklist for a human, and the scripted run is its automated
  equivalent.

**Stopping here** as instructed — PR #1 remains open and unmerged.
