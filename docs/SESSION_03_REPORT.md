# Session 3 Report — Visual Foundation (rendered office + animation engine)

Branch: `arena/6e75ac98-proxi` · Scope: **Section 3 / "Session 2: the visual foundation of ProxiSpeak"**

This section turns the working shell from Section 2 into a fully rendered, playable
top-down office. Everything on screen is drawn by our own Canvas 2D code — no images,
no external assets, no emoji furniture, no placeholder rectangles.

Per instruction, I **stopped after this section**: no multiplayer, no audio, no further milestones.

---

## 1. What was built

### World geometry — data only, zero drawing code (`client/src/world/`)

| File | Lines | Responsibility |
| --- | --- | --- |
| `worldData.js` | 440 | Logical world 2560 × 1600 u: 12 rooms, 28 walls, 13 doors, 98 furniture items, 31 decor overlays, 3 spawns, 126 colliders, floor styles, walkable bounds, collider grids |
| `collision.js` | 75 | Circle-vs-AABB with axis-separated resolution, spatial-grid queries |
| `spatialGrid.js` | 54 | Uniform grid used for both collision lookups and render culling |
| `math.js` | 83 | `damp`, `dampAngle`, `normalize`, clamps — frame-rate independent easing |
| `random.js` | 41 | Seeded RNG + string hash, so appearance/props are deterministic |

Room list (all requested areas): Reception & Entrance (with lobby archway and glass
entrance at the south wall), Open Workspace in the centre, Meeting Room + Lounge along
the top, Office A / Office B / Office C and Storage & Copy down the left, Kitchen,
Huddle Room down the right, and a Restroom in each bottom corner.

### Rendering — pure functions of state (`client/src/render/`)

| File | Lines | Responsibility |
| --- | --- | --- |
| `palette.js` | 163 | The single source of colour: floors, walls, wood, fabric, metal, glass, plants, accents, label tones |
| `worldRenderer.js` | 604 | Backdrop, floors, rugs, walls (4-pass: drop shadow → body → lit inner cap → hairline), doors (hinged leaves, glass, archways), light pools, wall art, vignette, room nameplates |
| `furniture.js` | 729 | One drawer per furniture type (21 types) plus 14 surface props (monitor, keyboard, mug, bell, sink, stove, coffee machine, printer, toilet, …) |
| `avatarAppearance.js` | 88 | Deterministic avatar look from the player id: skin, hair colour/style, shirt, trousers, accessory, accent |
| `avatarRenderer.js` | 698 | Facing-aware avatar: animated walk cycle, idle pose, blink, soft shadow, local-player ring, speaking pulse, proximity halo, name labels with mic/proximity badges |
| `camera.js` | 211 | World⇄screen transforms, damped pan/zoom, zoom-to-cursor, follow, letterbox centring, clamping to world bounds |

### Engine (`client/src/render/engine.js`, 605 lines)

One `requestAnimationFrame` loop with delta time clamped to 100 ms, device-pixel-ratio
aware canvas sizing (DPR capped at 2, resized on `ResizeObserver`/`resize` — never per
frame), circle-vs-AABB movement with acceleration/deceleration and turn damping, walk
cycle driven by distance travelled, y-sorted depth drawing, and HUD state published to
React at 5 Hz instead of every frame.

### Input (`client/src/input/keyboard.js`, 162 lines)

WASD + arrow keys, `+`/`−` zoom, `0` reset zoom, `R` reset camera, `F` camera follow,
`L` labels, `1`–`3` spawns; auto-repeat ignored, browser defaults suppressed only for
movement keys, and a fail-safe typing guard so anything typed into an input,
textarea, select or `contenteditable` is never stolen.

### React layer (`client/src/components/`, `client/src/state/`)

`Workspace.jsx` (stage + HUD), `WorldCanvas.jsx` (engine lifecycle, error banner,
keyboard hint bar), `WorldControls.jsx` (toolbar: zoom −/+, reset, follow, labels,
spawn chips), `WorldPanel.jsx` (live world read-out), `state/worldStore.js`
(observable store written by the engine), `state/hooks.js` (`useSyncExternalStore`).

### Developer aid

`client/scripts/render-preview.mjs` (158 lines) renders the real pipeline to a PNG with
Node canvas — how the layout was reviewed at each viewport size. Optional dependency,
not part of the app bundle: `npm install --no-save @napi-rs/canvas`.

---

## 2. How to run

```bash
npm install                 # root (installs client + server workspaces)
npm run dev                 # Express + Socket.IO on 8080, Vite on 5173
# open http://localhost:5173
```

Other commands: `npm test` (both suites), `npm run build`, `npm run lint`.
Environment files stay placeholder-only (`.env.example`); nothing was committed.

Controls: **WASD / arrows** move · **mouse wheel** zoom to cursor · **drag** pan ·
**double-click** reset · **+/−/0** zoom · **R** reset camera · **F** follow ·
**L** labels · **1/2/3** spawns.

---

## 3. Test results (actually executed)

| Suite | Result |
| --- | --- |
| `client` — `npm test` | **143 passed / 143**, 11 files |
| `server` — `npm test` | **29 passed / 29**, 3 files (unchanged from Section 2) |
| `npx eslint .` (root and client) | clean, no warnings |
| `npm run build` (client) | 86 modules → JS 263.32 kB (84.49 kB gz), CSS 9.37 kB (2.81 kB gz), 1.78 s |
| `scripts/smoke-socket.mjs` direct | 5/5 checks |
| `scripts/smoke-socket.mjs` via Vite proxy | 5/5 checks |

Per-file client breakdown:

| Test file | Tests | Covers |
| --- | --- | --- |
| `render/engine.test.js` | 34 | rAF lifecycle, destroy/teardown, movement + facing, collision on the real map, camera integration, DPR sizing, HUD throttling, peer injection |
| `render/renderer.test.js` | 24 | full frames at 6 viewports × 5 zooms, 6 corner cameras, culling, every furniture type and rotation, avatar facings/blink/labels, appearance determinism |
| `input/keyboard.test.js` | 18 | WASD + arrows, ±1 axis clamping, typing guard (attribute *and* property form), shortcuts, auto-repeat, modifier keys, detach |
| `world/worldData.test.js` | 17 | world size, 12 rooms non-overlapping, no furniture clipped by a wall, doorways wide and passable, spawns walkable, chair orientation |
| `render/camera.test.js` | 14 | 7 viewports × 5 zooms clamped inside the world, letterbox centring, zoom-to-cursor anchoring, follow/pan/reset, exact round-trip |
| `world/collision.test.js` | 13 | circle-vs-AABB, axis separation, corners, fully-contained circles, bounds |
| `components/Workspace.test.jsx` | 8 | toolbar buttons drive the engine, zoom clamping, spawn teleport, HUD publish cadence, store-driven re-render, unmount cleanup |
| `components/WorldCanvas.test.jsx` | 5 | mounts the canvas, starts the engine, publishes state, reacts to keys, **cleans the loop up on unmount**, survives a missing 2D context |
| `App.test.jsx` + `App.offline.test.jsx` | 8 | Section 2 shell, connectivity states, backend-offline guidance (re-run against the new tree) |
| `config/env.test.js` | 2 | env parsing |

Acceptance criteria demonstrated by those tests:

* **Animation loop cleaned up on unmount** — `WorldCanvas.test.jsx` asserts no pending
  frame, `running === false`, keyboard detached, no frame after unmount and no move.
* **No React re-render per frame** — `Workspace.test.jsx` walks the avatar for 300
  frames (~5 s) and asserts the store published 20–34 times with ≥190 ms between
  publishes (5 Hz), never once per frame.
* **Stable at different viewport sizes / nothing clipped** — camera clamping matrix over
  7 viewports × 5 zooms, full-scene renders at 6 viewports, and the world-data test that
  no furniture footprint breaks a wall or the walkable bounds.
* **Delta-time movement** — huge-delta test shows a tab switch cannot teleport the avatar.

---

## 4. Visual verification (real renders, not just assertions)

Because the sandbox has no browser, I rendered the **actual pipeline** to PNGs at
390 × 844, 900 × 620, 1000 × 660, 1100 × 700, 1280 × 720, 1440 × 900, 1600 × 1000 and
2560 × 1440 (zooms 0.5–2) and inspected every room. Confirmed: cohesive palette and
lighting, readable room nameplates, no furniture clipped by walls or viewport edges, no
missing assets, and the whole plan legible at min zoom.

Bugs this review caught and fixed:

1. **Eight chairs faced the wrong way** — desk chairs in Offices A/B/C and the pod desks
   turned away from their desks; four south-pod chairs sat on the monitor side of the
   desk. Fixed, and the check is now a permanent test (`points every chair at the
   furniture it is pulled up to`), verified to fail on the old data.
2. **Water cooler rendered as a blank tile**, which read as a placeholder. Now a proper
   cooler: bottle silhouette, recessed alcove, two taps, drip tray, paper cup.
3. **Two `fillRoundRect` calls were missing their radius**, passing `NaN` into the
   context (caught by the recording fake context, which throws on non-finite arguments).
4. **`PALETTE.metal.mid` did not exist** (silently produced `undefined`); corrected to
   the real palette entry.
5. **The typing guard could fail open** — `isContentEditable` is not implemented by
   jsdom or some embedded webviews, so the guard now also checks the `contentEditable`
   property and the `contenteditable` attribute.
6. **React's `act()` environment was not enabled** in tests (warning on every component
   assertion, updates could leak between tests). Added `src/test/setup.js` via
   `setupFiles` in `vite.config.js`.
7. The room nameplate sub-caption showed raw debug dimensions (`1632 × 456 · reception`);
   it now shows a plain description (`welcome desk`), driven by world data.

---

## 5. Files

**Added (27):** `client/src/world/{worldData,collision,spatialGrid,math,random}.js`,
`client/src/world/{worldData,collision}.test.js`,
`client/src/render/{palette,worldRenderer,furniture,avatarAppearance,avatarRenderer,camera,engine}.js`,
`client/src/render/{camera,renderer,engine}.test.js`, `client/src/input/{keyboard.js,keyboard.test.js}`,
`client/src/state/worldStore.js`, `client/src/components/{WorldCanvas.jsx,WorldControls.jsx,WorldPanel.jsx}`,
`client/src/components/{WorldCanvas,Workspace}.test.jsx`, `client/src/test/{fakeCanvas.js,setup.js}`,
`client/scripts/render-preview.mjs`

**Changed (8):** `client/src/App.jsx`, `client/src/components/{Workspace,AppFooter}.jsx`,
`client/src/state/hooks.js`, `client/src/styles/global.css` (+154 / −28 lines of live-stage CSS),
`client/src/world/math.js`, `client/vite.config.js` (test setup file), `.gitignore` (`.preview/`)

Section 2's shell, backend and socket layer are untouched apart from the App/Workspace
rewire; `GET /api/health` and the Socket.IO handshake still pass their smoke checks.

---

## 6. Known limitations (deliberate, next sections)

* **No multiplayer and no audio.** The local avatar is the only moving entity. Peer
  rendering exists and is tested (`setPeers` / `upsertPeer` / `removePeer`), so the
  presence milestone can drive remote avatars through the same draw path — but nothing
  is networked yet.
* **No interpolation buffer yet.** Remote avatars accept `x`, `y`, `facing`, `walkPhase`,
  so the documented 120 ms interpolation and 150 ms extrapolation cap will slot in
  behind the same API.
* The HUD in this section displays session/backend/world information; it is not yet a
  participant roster.
* Mobile touch input (virtual stick) is not implemented — keyboard and pointer only.
* Visual verification is headless (real Canvas code rendered to PNG via Node canvas);
  the sandbox has no browser, so mouse-wheel feel and 60 fps on real hardware were
  validated by the animation-loop tests (delta time, teardown, publish cadence) rather
  than by eye.
* `scripts/render-preview.mjs` needs `npm install --no-save @napi-rs/canvas`; it is a
  development aid and stays out of the app bundle and out of `package.json`.

**Stopping here** as instructed — this section ends with the visual foundation complete.
