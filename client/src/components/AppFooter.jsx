import { env, describeTargets } from '../config/env.js'

export function AppFooter({ connection, health, world }) {
  const checked = health.checkedAt ? new Date(health.checkedAt).toLocaleTimeString() : '—'
  const host = typeof window === 'undefined' ? 'server' : window.location.host
  const targets = describeTargets()

  return (
    <footer className="app-footer">
      <span>
        {env.appName} v0.1.0 · {env.mode} mode
      </span>
      <span>
        {world?.zoneName ? `room: ${world.zoneName}` : 'room: —'} · {world?.fps ?? 0} fps · {world?.peerCount ?? 0} peers
      </span>
      <span>
        origin {host} · socket {targets.socket}
      </span>
      <span>
        health checked {checked} · socket {connection.status}
      </span>
    </footer>
  )
}
