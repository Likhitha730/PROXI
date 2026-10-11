// React bindings for the client-side stores (thin: no business logic here).

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { connectionStore } from './connectionStore.js'
import { worldStore } from './worldStore.js'
import { presence } from '../net/presence.js'
import { apiUrl, describeTargets } from '../config/env.js'

/** Subscribe to the Socket.IO connection state. */
export function useConnection() {
  return useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot, connectionStore.getSnapshot)
}

/**
 * Subscribe to world/HUD state.
 *
 * The engine writes into this store at ~5 Hz, so the React tree re-renders a few
 * times per second at most — never once per animation frame.
 */
export function useWorldState() {
  return useSyncExternalStore(worldStore.subscribe, worldStore.getSnapshot, worldStore.getSnapshot)
}

/**
 * Subscribe to the presence roster (who else is online).
 *
 * The presence store only changes its snapshot on structural events — a join,
 * a leave, a rename, a session change — so 15 Hz movement never re-renders the
 * component tree.
 */
export function usePresence() {
  return useSyncExternalStore(presence.subscribe, presence.getSnapshot, presence.getSnapshot)
}

const HEALTH_POLL_MS = 10_000

/**
 * Polls GET /api/health. This is the "is the backend alive?" signal shown in the
 * HUD; it is intentionally independent from the Socket.IO connection state so
 * the UI can explain *why* it is disconnected.
 */
export function useBackendHealth() {
  const [health, setHealth] = useState({ status: 'loading', data: null, error: null, checkedAt: null })

  const check = useCallback(async (signal) => {
    try {
      const response = await fetch(apiUrl('/api/health'), {
        signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setHealth({ status: 'ok', data, error: null, checkedAt: Date.now() })
    } catch (error) {
      if (error?.name === 'AbortError') return
      setHealth({ status: 'error', data: null, error: error?.message ?? 'Unreachable', checkedAt: Date.now() })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    check(controller.signal)
    const timer = setInterval(() => check(controller.signal), HEALTH_POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [check])

  const recheck = useCallback(() => {
    setHealth((current) => ({ ...current, status: 'loading' }))
    check()
  }, [check])

  return { ...health, recheck, targets: describeTargets() }
}
