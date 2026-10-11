import { useCallback, useRef, useState } from 'react'
import { describeTargets } from '../config/env.js'
import { WorldCanvas } from './WorldCanvas.jsx'
import { WorldControls } from './WorldControls.jsx'
import { WorldPanel } from './WorldPanel.jsx'
import { WORLD_SUMMARY } from '../world/worldData.js'

function formatDuration(fromTimestamp) {
  if (!fromTimestamp) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - fromTimestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Main workspace: the live Canvas office plus the session/backend/world HUD.
 *
 * The engine instance lives in a ref (it is imperative and long-lived); the
 * `engineVersion` counter exists only so the controls re-render once when the
 * engine becomes available.
 */
export function Workspace({ connection, health, world, onEngineReady }) {
  const targets = describeTargets()
  const databaseStatus = health.data?.database?.status ?? '—'
  const engineRef = useRef(null)
  const [, setEngineVersion] = useState(0)

  const handleEngineReady = useCallback(
    (engine) => {
      engineRef.current = engine
      setEngineVersion((version) => version + 1)
      onEngineReady?.(engine)
    },
    [onEngineReady],
  )

  return (
    <main className="workspace">
      <section className="stage" aria-label="World stage">
        <div className="stage__header">
          <h2 className="stage__title">World stage</h2>
          <span className="stage__hint">
            {WORLD_SUMMARY.zones} rooms · {WORLD_SUMMARY.furniture} furniture items · {WORLD_SUMMARY.doors} doors ·
            local avatar only
          </span>
        </div>

        <WorldControls engine={engineRef.current} world={world} />

        <WorldCanvas spawnId="entrance" playerName="You" onEngineReady={handleEngineReady} />
      </section>

      <aside className="hud" aria-label="Session details">
        <WorldPanel world={world} />

        <section className="panel">
          <h3 className="panel__title">Session</h3>
          <dl className="kv">
            <dt>State</dt>
            <dd data-testid="connection-state">{connection.status}</dd>
            <dt>Socket id</dt>
            <dd className="kv__mono" data-testid="socket-id">
              {connection.socketId ?? '—'}
            </dd>
            <dt>Transport</dt>
            <dd data-testid="transport">{connection.transport ?? '—'}</dd>
            <dt>Connected for</dt>
            <dd>{formatDuration(connection.connectedAt)}</dd>
            <dt>Attempts</dt>
            <dd>{connection.attempts}</dd>
          </dl>
        </section>

        <section className="panel">
          <h3 className="panel__title">Backend</h3>
          <dl className="kv">
            <dt>Health</dt>
            <dd>{health.status === 'ok' ? health.data?.status ?? 'ok' : health.status}</dd>
            <dt>Service</dt>
            <dd>{health.data?.service ?? '—'}</dd>
            <dt>Version</dt>
            <dd>{health.data?.version ?? '—'}</dd>
            <dt>Uptime</dt>
            <dd>{health.data ? `${health.data.uptimeSeconds}s` : '—'}</dd>
            <dt>Database</dt>
            <dd>{databaseStatus}</dd>
          </dl>
          {health.error ? <p className="panel__error">{health.error}</p> : null}
        </section>

        <section className="panel">
          <h3 className="panel__title">Endpoints</h3>
          <dl className="kv">
            <dt>Socket.IO</dt>
            <dd className="kv__mono">{targets.socket}</dd>
            <dt>REST</dt>
            <dd className="kv__mono">{targets.api}</dd>
          </dl>
        </section>
      </aside>
    </main>
  )
}
