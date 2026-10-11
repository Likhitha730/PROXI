// GET /api/ice — the ICE servers a browser should use for WebRTC.
//
// Why the server hands these out instead of baking them into the client bundle:
//
//   * TURN credentials are secrets. `VITE_*` values are inlined into the shipped
//     JavaScript, so a long-lived TURN credential placed there is published to
//     anyone who opens devtools. Served from here, the credential can be a
//     short-lived one that is rotated (and, in a real deployment, fetched from the
//     TURN provider's REST API per request).
//   * It keeps the relay configuration with the rest of the server environment
//     (`server/.env`, gitignored) instead of needing a second place to configure.
//
// This endpoint is intentionally the *only* place ICE configuration leaves the
// process. The response never contains anything else from the environment, and
// credentials are only included when a TURN server is actually configured.

import { Router } from 'express'

/**
 * Build the RTCConfiguration.iceServers shape used by `RTCPeerConnection`.
 *
 * @param {{ stunUrls?: string[], turnUrl?: string|null, turnUsername?: string|null, turnCredential?: string|null }} config
 */
export function buildIceServers({ stunUrls = [], turnUrl = null, turnUsername = null, turnCredential = null } = {}) {
  const servers = []
  if (stunUrls.length > 0) servers.push({ urls: [...stunUrls] })
  if (turnUrl) {
    // A TURN entry without credentials is still valid (some relays are open), but
    // most require them — include them exactly when they are configured.
    const turn = { urls: turnUrl }
    if (turnUsername) turn.username = turnUsername
    if (turnCredential) turn.credential = turnCredential
    servers.push(turn)
  }
  return servers
}

export function createIceRouter({ config }) {
  const router = Router()

  router.get('/ice', (_req, res) => {
    const iceServers = buildIceServers({
      stunUrls: config.iceStunUrls ?? [],
      turnUrl: config.iceTurnUrl ?? null,
      turnUsername: config.iceTurnUsername ?? null,
      turnCredential: config.iceTurnCredential ?? null,
    })

    // `Cache-Control: no-store`: a rotated credential must not be served stale, and
    // an intermediary must never hold on to it.
    res.set('Cache-Control', 'no-store')
    res.json({
      iceServers,
      // Clients use this to explain connectivity failures honestly: with no relay
      // configured, some networks simply cannot be reached (see docs §8).
      hasTurn: Boolean(config.iceTurnUrl),
      ttlSeconds: 300,
    })
  })

  return router
}
