// GET /api/health — liveness/readiness for humans, uptime monitors and the HUD.
//
// Contract: always 200 while the process can serve requests, and never expose
// environment values (no URIs, no secrets, no configured ports/origins).

import { Router } from 'express'
import process from 'node:process'
import { LIMITS } from '../../../shared/protocol.js'
import { getDatabaseStatus } from '../db/mongo.js'

export function createHealthRouter({ config }) {
  const router = Router()
  const startedAt = Date.now()

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: config.appName,
      version: config.version,
      environment: config.nodeEnv,
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      startedAt: new Date(startedAt).toISOString(),
      timestamp: new Date().toISOString(),
      // Coarse persistence state only — the driver reports "disabled" when
      // MONGODB_URI is not configured, which is a valid state for this milestone.
      database: getDatabaseStatus(),
      // The proximity radius is a shared constant (not configuration of the
      // deployment), so it is published the same way the move rate is: clients need
      // it to draw the ring even before the first proximity result arrives.
      realtime: {
        socketio: true,
        path: '/socket.io',
        moveHz: LIMITS.MOVE_UPDATES_PER_SECOND,
        proximityRadius: config.proximityRadius ?? LIMITS.PROXIMITY_RADIUS,
      },
    })
  })

  return router
}
