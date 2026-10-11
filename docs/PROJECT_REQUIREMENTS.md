# ProxiSpeak — Project Requirements

**Status:** Baseline for implementation
**Last updated:** 2026-10-11
**Owner:** Engineering (technical lead)

## 1. Product Vision

ProxiSpeak is a premium, real-time virtual office. Users control animated avatars in a polished 2D office rendered on HTML5 Canvas. When users come within earshot of each other, a WebRTC audio channel is established automatically, and voices are rendered with distance-based volume and stereo panning via the Web Audio API. The experience should feel like walking around a real office: you only hear the people near you.

## 2. Scope

### In scope (v1)

- Single shared office world ("room") with a fixed floor plan.
- Local avatar movement (keyboard) with smooth, delta-time-based animation.
- Real-time presence and movement synchronization of all connected users.
- Proximity detection with a visible "nearby users" panel.
- Proximity-filtered WebRTC voice connections (not a full mesh).
- Spatial audio: distance attenuation + stereo panning.
- Persistent user and position data in MongoDB Atlas (official Node.js driver).

### Out of scope (v1, later sessions)

- Authentication/accounts (anonymous join with a display name for now).
- Text chat, screen sharing, video.
- TURN relay infrastructure (STUN only; documented as a risk).
- Multiple rooms/maps, admin controls, mobile apps.
- Git repository setup and production deployment (handled in later sessions).

## 3. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | User joins with a display name (1–24 chars, sanitized) and receives a unique session id. |
| FR-2 | User moves the avatar with WASD/arrow keys at a fixed walk speed; movement is frame-rate independent (delta time). |
| FR-3 | Avatars cannot pass through walls, furniture, or leave the world bounds (collision). |
| FR-4 | Local avatar renders with directional walking animation and idle animation. |
| FR-5 | Remote avatars render with interpolated positions (network jitter buffer) and direction. |
| FR-6 | Server broadcasts position updates; clients render all connected users. |
| FR-7 | Server computes proximity; clients receive a throttled "nearby users" list with distances. |
| FR-8 | WebRTC peer connections are created only with users inside the audio range and torn down when they leave it. |
| FR-9 | Microphone permission is requested on first join; denial is handled gracefully with a clear UI state. |
| FR-10 | Remote audio is played through a Web Audio graph with distance-based gain and stereo panning. |
| FR-11 | Connection/disconnection states are surfaced in the UI (connecting, connected, disconnected, error). |
| FR-12 | Office floor plan includes: reception/entrance, central open workspace, private offices (left and right), meeting room/lounge (top), kitchen and huddle room (right), restrooms (bottom corners), plus desks, chairs, plants, walls. |

## 4. Non-Functional Requirements

- **Performance:** 60 fps canvas rendering on a mid-range laptop; ≤ 15 Hz position updates per client; interpolation hides ~200 ms of network jitter.
- **Portability:** frontend dev server on port 5173 (Vite); the app must fail clearly if 5173 is occupied — never silently switch ports.
- **Security:** all Socket.IO payloads validated server-side; no secrets in source; `.env` never committed; CORS restricted to the frontend origin.
- **Reliability:** server cleans up all per-user state on disconnect (sockets, peers, audio nodes, DB records); no unbounded event listeners.
- **Browser support:** current Chrome/Edge/Firefox/Safari (WebRTC + StereoPannerNode).
- **Maintainability:** JavaScript only (no TypeScript); no unnecessary libraries; rendering strictly separated from network state.

## 5. Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + Vite (port 5173), JavaScript, CSS |
| Realtime | Socket.IO (WebSocket with polling fallback) |
| Backend | Node.js + Express |
| Database | MongoDB Atlas, official `mongodb` driver |
| Audio transport | WebRTC (STUN; TURN deferred) |
| Audio processing | Web Audio API (GainNode, StereoPannerNode) |
| 2D world | HTML5 Canvas 2D, custom renderer |

## 6. Acceptance Criteria (end of v1)

1. Two browser tabs: avatars move smoothly, collision works, remote avatars interpolate.
2. Approaching another user shows them in the nearby panel and establishes audio; walking away tears it down.
3. Distance attenuation and stereo panning are audible and monotonic with distance.
4. Disconnect/reconnect cleans up all state; no console errors.
5. `npm run dev` starts the frontend on port 5173 and fails loudly if the port is taken.
