// ICE configuration — where the browser's RTCPeerConnection finds relays.
//
// Order of preference:
//
//   1. `GET /api/ice` — the server's configuration. This is the preferred source
//      because TURN credentials are secrets: `VITE_*` values are inlined into the
//      shipped bundle, where anyone can read them, while a server-served credential
//      can be short-lived and rotated (docs/ARCHITECTURE.md §8).
//   2. `VITE_ICE_*` — a local override for development against a specific relay,
//      without running the backend. Documented, not recommended for production.
//   3. The built-in public STUN server, so a plain browser-to-browser call still
//      works with no configuration at all.
//
// A failure to fetch is never fatal: a call over the local network (or localhost)
// works with no ICE servers at all, and a restrictive network would need TURN
// anyway — the caller is told which case applies via `source`.

import { apiUrl, env } from '../config/env.js'

/** Used when nothing is configured anywhere. */
export const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: ['stun:stun.l.google.com:19302'] }),
])

const CACHE_MS = 5 * 60 * 1000

let cached = null
let fetchedAt = 0
let inflight = null

/** Client-side override, if any was configured at build time. */
function clientConfiguredServers() {
  const urls = String(env.iceStunUrls ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const turnUrl = String(env.iceTurnUrl ?? '').trim()
  if (urls.length === 0 && !turnUrl) return null

  const servers = []
  if (urls.length > 0) servers.push({ urls })
  if (turnUrl) {
    const turn = { urls: turnUrl }
    if (env.iceTurnUsername) turn.username = env.iceTurnUsername
    if (env.iceTurnCredential) turn.credential = env.iceTurnCredential
    servers.push(turn)
  }
  return servers
}

/**
 * Validate a server-supplied ICE list. Anything malformed is dropped rather than
 * handed to `RTCPeerConnection`, which throws on a bad configuration — and one bad
 * entry must not cost us the whole call.
 */
function sanitise(iceServers) {
  if (!Array.isArray(iceServers)) return []
  const result = []
  for (const entry of iceServers) {
    if (!entry || typeof entry !== 'object') continue
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
      .filter((url) => typeof url === 'string' && /^(stun|turn|turns):/i.test(url.trim()))
      .map((url) => url.trim())
    if (urls.length === 0) continue
    const server = { urls }
    if (typeof entry.username === 'string' && entry.username.length > 0) server.username = entry.username
    if (typeof entry.credential === 'string' && entry.credential.length > 0) server.credential = entry.credential
    result.push(Object.freeze(server))
  }
  return result
}

/**
 * Resolve the ICE servers to use.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, force?: boolean }} [options]
 * @returns {Promise<{ iceServers: object[], hasTurn: boolean, source: string }>}
 */
export async function resolveIceServers({ fetchImpl = globalThis.fetch, now = () => Date.now(), force = false } = {}) {
  const override = clientConfiguredServers()
  if (override) {
    return {
      iceServers: sanitise(override),
      hasTurn: override.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))),
      source: 'client-env',
    }
  }

  if (!force && cached && now() - fetchedAt < CACHE_MS) return cached
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const response = await fetchImpl?.(apiUrl('/api/ice'), { headers: { accept: 'application/json' } })
      if (!response?.ok) throw new Error(`ICE endpoint responded ${response?.status ?? 'no response'}`)
      const body = await response.json()
      const iceServers = sanitise(body?.iceServers)
      if (iceServers.length === 0) throw new Error('ICE endpoint returned no usable servers')
      const resolved = { iceServers, hasTurn: Boolean(body?.hasTurn), source: 'server' }
      cached = resolved
      fetchedAt = now()
      return resolved
    } catch {
      // No backend, no network, or a broken response: fall back to public STUN.
      // `source` records that this happened, so the UI can say so honestly.
      const fallback = {
        iceServers: sanitise(DEFAULT_ICE_SERVERS),
        hasTurn: false,
        source: 'default-stun',
      }
      cached = fallback
      fetchedAt = now()
      return fallback
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Test helper: forget the cache so the next resolve hits the source again. */
export function resetIceCache() {
  cached = null
  fetchedAt = 0
  inflight = null
}
