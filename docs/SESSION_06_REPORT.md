# Session 6 report — real proximity-based WebRTC audio signalling

Scope: this session adds proximity **voice**. Two sessions inside the 100-unit
listening radius, each with a live microphone, get one `RTCPeerConnection` each and
exchange audio directly — peer to peer, never through the server. The server's job is
narrow and strict: decide *whether* two sessions may call, and relay SDP and ICE
between them without ever trusting a client's claim about who it is.

Nothing from the previous sessions was redesigned: the 2D world, the multiplayer
protocol, the MongoDB archive and the proximity engine all keep their contracts. The
protocol **grows** from 8 to 15 event names; the previous 8 are unchanged, except that
a player record now also carries `audio: { enabled, muted }`.

**No distance-based volume and no stereo panning** — every call plays at full volume.
`docs/ARCHITECTURE.md` §9 (the spatial audio graph) is explicitly marked as a design
note for a later session.

---

## 1. Read this first: what was verified, and what was not

This sandbox has **no browser, no microphone and no speakers**. That single fact
determines how far the verification reaches, so it is stated before anything else.

| Layer | How it was verified | Confidence |
|-------|--------------------|------------|
| Server authorization, relay, revocation, rate limiting | 25 unit tests + 19 integration tests over real Socket.IO clients | verified |
| Client negotiation logic (roles, glare, teardown, mic consent) | 45 tests against a fake `RTCPeerConnection`/`mediaDevices`/`<audio>` | verified |
| Signalling over the wire end to end | `scripts/verify-audio.mjs`, two scripted sessions against a running server | verified |
| **Actual audio transport** | same script, `@roamhq/wrtc` as the WebRTC implementation: **real DTLS-SRTP**, real Opus encoding, 74 400 / 74 240 samples received in the two directions | verified in Node |
| Browser microphone capture (`getUserMedia`) | **NOT VERIFIED** — no microphone device and no browser here | unverified |
| Audio playback through speakers | **NOT VERIFIED** — no audio output device; the script drains remote tracks into an `RTCAudioSink` and counts frames | unverified |
| Browser autoplay policy / echo cancellation behaviour | **NOT VERIFIED** — jsdom has neither | unverified |
| The Voice panel as a human sees it | **NOT VERIFIED visually** — asserted via jsdom rendering (14 tests), never looked at | partially |

So: the protocol, the authorization rules, the negotiation and the media path are all
exercised with real code and real packets; what is missing is the *browser's* half of
the story — a human speaking into a real microphone and hearing a real voice. §8 is the
exact manual procedure to close that gap on a machine with two browsers.

### 1.1 A real bug this session's end-to-end run caught

The first `verify-audio.mjs` run failed with
`audio peer failed … could not create an offer: Expected an object`. The engine called
the argument-less `setLocalDescription()`, which browsers support but which is **not**
universal — `@roamhq/wrtc` (and anything implementing the spec strictly) requires the
description to be passed in. The engine now calls `createOffer()` / `createAnswer()` and
passes the result explicitly. The unit tests would never have caught this: their fake
implemented whichever behaviour it was written to expect. §4 keeps the fix, and the
fake now **rejects** an argument-less call, so the bug cannot come back.

---

## 2. Files

**New — server**

| File | Purpose |
|------|---------|
| `server/src/realtime/audio.js` | The audio service: pair table, authorization verdicts, signal relay, hysteresis, revocation, diagnostics |
| `server/src/routes/ice.js` | `GET /api/ice` — serves the ICE configuration (STUN, optional TURN) |
| `server/src/realtime/audio.test.js` | 25 unit tests |
| `server/src/sockets/audio.test.js` | 19 integration tests over real Socket.IO clients |

**New — client**

| File | Purpose |
|------|---------|
| `client/src/audio/audioEngine.js` | The WebRTC peer manager: microphone lifecycle, one connection per peer, perfect negotiation, audio sink, speaking flags, teardown |
| `client/src/audio/iceConfig.js` | ICE resolution: `/api/ice` → `VITE_ICE_*` → public STUN, 5-minute cache, never throws |
| `client/src/audio/voiceActivity.js` | RMS voice-activity detection (one boolean out, no samples) |
| `client/src/components/AudioPanel.jsx` | The Voice panel: mic button, permission/error status, mute, connection and speaking indicators |
| `client/src/audio/audioEngine.test.js` | 45 tests against fake WebRTC/mediaDevices/`<audio>` |
| `client/src/audio/iceConfig.test.js` | 17 tests |
| `client/src/audio/voiceActivity.test.js` | 9 tests |
| `client/src/components/AudioPanel.test.jsx` | 14 tests |

**New — tooling**

| File | Purpose |
|------|---------|
| `scripts/verify-audio.mjs` | 18 scripted end-to-end checks against a running server, with real SRTP |

**Changed**

| File | Change |
|------|--------|
| `shared/protocol.js` | +7 event names (15 total), audio validators, pair/status helpers, audio limits |
| `server/src/sockets/handlers.js` | Audio listeners, per-session signalling rate limit, authorization on join/move/disconnect |
| `server/src/realtime/registry.js` | `setAudio(socketId, audio)` |
| `server/src/app.js` | Mounts `/api/ice`; endpoint index updated |
| `server/src/config/env.js` | `parseIceUrls`, `ICE_STUN_URLS`, `ICE_TURN_*` |
| `client/src/net/socketClient.js` | Owns the engine's transport; dispatches audio events; drops sessions on disconnect |
| `client/src/components/WorldCanvas.jsx` | Stamps speaking/muted onto the avatars drawn each frame |
| `client/src/components/Workspace.jsx`, `client/src/App.jsx`, `client/src/state/hooks.js` | Mount the Voice panel, `useAudio()` |
| `client/src/config/env.js` | `VITE_ICE_*` overrides; `import.meta.env` fallback so client modules load in Node |
| `client/src/styles/global.css` | Voice panel styles, including the speaking indicator |
| `server/.env.example` | Documented ICE section, empty TURN values |
| `docs/ARCHITECTURE.md` | §8 rewritten as implemented; §2/§6/§9/§10/§11 updated |
| `README.md`, `package.json` | `npm run verify:audio` |
| `package.json` | `@roamhq/wrtc` as a dev dependency (never in the browser bundle) |

---

## 3. The authorization rule, and why the server never trusts a client

A pair may call when **all** of these hold, evaluated from the server's own state:

1. both sessions declared a live microphone (`audio:ready { enabled: true }`),
2. both are within 100 world units — or within 100 + 12 units once already allowed, so
   a step across the boundary does not flap the call,
3. neither has disconnected.

Identity is never read from a payload. `targetId` is the only client-supplied field
that is honoured, and it is resolved through the server's own pair table; anything
resembling a sender id (`fromId`, `from`, `id`) is discarded. Relayed packets are
re-stamped with the sender's id and display name derived from the socket's session.

Verified, including the hostile cases:

* a client sending `fromId`/`from`/`id` cannot make a signal appear to come from
  another player (integration test; plus a live check: **0** of the offers relayed in
  the whole run were attributed to the receiver);
* signals to a player who is out of range, not ready, no longer connected, or who is
  the sender themselves are refused with `audio_not_ready`,
  `audio_target_unavailable` or `invalid_signal`;
* SDP longer than 12 000 characters and candidates longer than 1 000 characters are
  rejected; signalling is capped at 40 messages/second with a burst of 80 (a flood is
  rate-limited, verified over the wire);
* after the microphone is switched off, signalling is refused outright
  (`audio_not_ready`) — a live check, not only a unit test.

Revocation is symmetric: `audio:status { allowed: false }` goes to **both** sides with
a reason (`out_of_range`, `peer_ineligible`, `self_ineligible`, `peer_left`, `denied`),
so neither side keeps a call the server no longer authorizes.

---

## 4. WebRTC implementation

* **Microphone consent.** `getUserMedia({ audio: { echoCancellation, noiseSuppression,
  autoGainControl } })` is called from the button's click handler and nowhere else —
  there is no effect, timer or "convenience" path that opens a microphone. A test
  asserts that mounting the UI never calls `getUserMedia`.
* **One connection per peer.** `addPeer` reuses an existing entry; the duplicate-connection
  case is tested explicitly (three `authorize` calls → one `RTCPeerConnection`).
* **Perfect negotiation.** Politeness is derived from player-id ordering, so both sides
  agree without a round trip: the smaller id is impolite (offers, ignores a colliding
  offer), the larger is polite (rolls back its own offer if one arrives). Verified from
  both roles, and live — one of the runs had Alice polite, the other had her impolite,
  and both negotiated successfully.
* **Descriptions.** `createOffer()`/`createAnswer()` are called explicitly and passed to
  `setLocalDescription` (see §1.1).
* **ICE.** Candidates are relayed as they are gathered; `null` (end-of-candidates) is
  relayed too; candidates arriving before the remote description are queued and flushed
  afterwards; candidates for unknown peers are ignored rather than throwing.
* **Audio sink.** Remote tracks are attached to an `<audio>` element the engine creates,
  positions off-screen and removes on teardown. A rejected `play()` (autoplay policy)
  is recorded as a flag for the UI instead of being swallowed.
* **Teardown.** Walking out of earshot, muting, switching the microphone off, hanging up
  or disconnecting closes the `RTCPeerConnection` (handlers detached *before* close),
  stops the voice detector, clears `srcObject`, pauses and removes the element, and
  stops every local track when the microphone is released. Every path is tested.
* **Graceful degradation.** Denied permission, missing device, a browser without
  `getUserMedia`, a browser without `RTCPeerConnection`, a failed ICE negotiation and a
  failed offer creation each become a state or an error string in the panel — none of
  them throws out of an event handler.
* **No audio content in logs.** The engine logs ids, states, sizes and error *names*.
  A test asserts that after a full flow (offer, answer, 9 candidates, a remote track, a
  hang-up) no log line contains `candidate:`, an SDP body or an `m=audio` line.

### 4.1 Client-side speaking indicators

Speaking is detected with an `AnalyserNode` reading the waveform, thresholded on RMS
(`0.045`) with a 260 ms hangover. It publishes **one boolean** — no samples, no level,
no recording — and the analyser is connected to nothing, so analysing the local
microphone cannot cause echo. The local flag drives the "you are speaking" dot; remote
flags are stamped onto the avatar peers each frame by `annotatePeers`, so the canvas
never re-renders React per frame.

---

## 5. ICE configuration

`GET /api/ice` → `{ iceServers, hasTurn, ttlSeconds: 300 }` with `Cache-Control: no-store`.
Resolution order in the client: `/api/ice` → `VITE_ICE_*` (development override) →
built-in public STUN. The resolved `source` and `hasTurn` are kept in state, so the UI
can say honestly whether a relay was available when a connection fails.

Live output (through the Vite proxy, i.e. exactly the path a browser takes):

```json
{"iceServers":[{"urls":["stun:stun.l.google.com:19302"]}],"hasTurn":false,"ttlSeconds":300}
```

**TURN credentials are never committed.** `server/.env.example` ships the keys with
empty values and a warning; `.env` is git-ignored; the logger scrubs the values it
prints. This is also why the credentials are served from the API at runtime instead of
being read from `VITE_*` — anything in `VITE_*` is inlined into the shipped bundle and
readable by anyone. Restrictive networks (symmetric NAT, corporate firewalls, UDP
blocked) genuinely need a relay; the panel says so when a connection fails and no relay
is configured, and the docs say so in §8.4.

---

## 6. Test results — as run

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Server (`server`: vitest) | 14 | **205** | all passing (was 161) |
| Client (`client`: vitest) | 19 | **315** | all passing (was 222) |
| Root ESLint (`npx eslint .`) | — | — | clean |
| Client production build | — | — | clean, 94 modules, 296.15 kB js / 95.56 kB gz |

New server tests: `realtime/audio.test.js` (25), `sockets/audio.test.js` (19).
New client tests: `audio/audioEngine.test.js` (45), `audio/iceConfig.test.js` (17),
`audio/voiceActivity.test.js` (9), `components/AudioPanel.test.jsx` (14), plus 7 added
to `net/socketClient.test.js` (the transport, the event dispatch, the disconnect path).

### 6.1 Scripted end-to-end check

`node scripts/verify-audio.mjs` (two sessions, the real client audio engine, real SRTP),
run against the live backend — 18/18:

```
  PASS  no microphone is opened until the user asks — mic=idle
  PASS  walking within the radius makes the players neighbours — spawned 1360u apart, bob now sees [Alice@40u]
  PASS  enabling the microphone announces audio:ready — sent=[{"enabled":true,"muted":false}]
  PASS  the microphone is active locally after enable() — alice=active bob=active
  PASS  the server authorizes the pair (audio:status ready, allowed) — status=ready
  PASS  the peer notice carries the other player’s name and mute state — notices=2
  PASS  exactly one peer connection per side — alice=1 bob=1 direction=polite
  PASS  offers, answers and ICE candidates crossed the server — offers=1 answers=1 ice=9
  PASS  both RTCPeerConnections report connected — alice=connected bob=connected
  PASS  audio arrives in both directions (real SRTP) — alice 157 frames / 74400 samples,
        bob 156 frames / 74240 samples
  PASS  the tone keeps flowing while connected — last sample 0s ago
  PASS  muting is announced to the peer as a flag — muted=true
  PASS  walking out of the listening radius revokes the pair on both sides — bob walked 360u
  PASS  the clients tear the connection down when the server revokes it — alice peers=0 bob peers=0
  PASS  a spoofed fromId never makes a signal appear to come from the victim
  PASS  signalling after the microphone is off is refused by the server — code=audio_not_ready
  PASS  switching the microphone off stops the local track and resets the state — mic=idle
  PASS  audio:ready { enabled: false } is sent when the microphone is switched off
```

What this does **not** prove: that a browser captures a microphone, that a speaker
plays the audio, or that echo cancellation works. Those need §8.

`node scripts/verify-multiplayer.mjs` still passes 17/17, so the presence, movement and
proximity behaviour from the earlier sessions is intact.

---

## 7. How to see it in the workspace

Backend on `:8080` and Vite on `:5173` (both bound to `0.0.0.0`):

```bash
npm run dev            # or: npm run dev:server / npm run dev:client
npm run verify:audio   # two scripted sessions, real WebRTC audio
npm test               # 205 + 315 tests
```

The Voice panel sits in the HUD between Players and Session: **Enable microphone**,
**Mute/Unmute**, a status line that always states in words whether the microphone is
live ("Microphone active — people nearby can hear you", "…muted. Nobody can hear you"),
the permission error when there is one, a count of voice connections with per-peer
speaking/connecting/muted indicators, and a note naming the listening radius in use.

---

## 8. Manual two-browser procedure (what a human still has to do)

The parts of the acceptance criteria that need a real browser and a real microphone.
`localhost` is a secure context, so no TLS is needed locally; over a network, serve the
app over **HTTPS** or the browser will refuse the microphone.

1. Start the backend and the frontend; open `http://localhost:5173` in **two different
   browsers** (not two tabs of the same one — some browsers share the microphone
   permission and the audio device per process, which makes the test ambiguous).
2. In both windows: enter different names. Both spawn at the entrance, ~1360 units
   apart, so walk one avatar towards the other until they are inside the ring.
3. **Before** pressing anything, confirm the status line says "Microphone off. Nothing
   is captured."
4. In window A press **Enable microphone** → the browser asks for permission → grant it
   → the line says "Microphone active — people nearby can hear you", the dot turns cyan
   and pulses when you speak, and a peer row for B appears (connecting → connected).
5. In window B do the same. **Expect:** B's row for A is "connected", and speaking into
   A's microphone shows "speaking" next to A in B's list; sound is audible in both
   directions.
6. Press **Mute** in A → the line says "Nobody can hear you", B's row shows a `muted`
   badge, and B stops hearing A. Unmute → audio returns.
7. Walk A away until the distance exceeds 100 units → **both** windows drop the row and
   the connections close; walking back re-establishes the call automatically.
8. Press the microphone button again (now "Microphone on") → tracks stop, the status
   returns to "Microphone off", and the peer row disappears.
9. Deny the permission when asked (or revoke it in the browser's site settings and
   reload) → the panel shows "Microphone permission was denied…" and the rest of the app
   keeps working: movement, proximity and the world are unaffected.
10. Optional, for a restrictive network: configure `ICE_TURN_*` on the server, restart,
    confirm `GET /api/ice` reports `hasTurn: true`, then repeat steps 4–6 across two
    different networks.

Not testable in this sandbox, in one line: **steps 4–8 have never been executed by a
human, because there is no browser and no microphone here.**

---

## 9. Deliberately not done

* No distance-based volume and no stereo panning (explicitly excluded this session).
* No recording, no transcription, no audio upload — audio never touches the server.
* No TURN server is run here (no relay is needed for the verification; the local network
  path connects directly). TURN is configured, documented and reported on, not deployed.
* No call UI beyond what was asked for (no grid view, no per-peer volume slider).
* The MongoDB archive is untouched by this session; positions keep being persisted as in
  session 5, with no MongoDB server in this sandbox (see `docs/SESSION_05_REPORT.md`).
