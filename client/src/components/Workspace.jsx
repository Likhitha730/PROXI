import { describeTargets } from '../config/env.js'

function formatDuration(fromTimestamp) {
  if (!fromTimestamp) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - fromTimestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function BlueprintPlaceholder() {
  // Purely decorative preview of the fixed floor plan that the Canvas renderer
  // will draw in the next milestone. It is not interactive and holds no state.
  return (
    <svg className="blueprint" viewBox="0 0 640 400" role="img" aria-label="Floor plan preview (placeholder)">
      <g className="blueprint__rooms">
        <rect x="16" y="16" width="150" height="110" rx="6" />
        <rect x="16" y="140" width="150" height="110" rx="6" />
        <rect x="180" y="16" width="280" height="130" rx="6" />
        <rect x="180" y="160" width="280" height="110" rx="6" />
        <rect x="474" y="16" width="150" height="110" rx="6" />
        <rect x="474" y="140" width="150" height="110" rx="6" />
        <rect x="16" y="264" width="150" height="120" rx="6" />
        <rect x="474" y="264" width="150" height="120" rx="6" />
        <rect x="180" y="284" width="280" height="100" rx="6" />
      </g>
      <g className="blueprint__labels">
        <text x="91" y="75">Private office</text>
        <text x="91" y="199">Private office</text>
        <text x="320" y="85">Meeting room / lounge</text>
        <text x="320" y="219">Open workspace</text>
        <text x="549" y="75">Kitchen</text>
        <text x="549" y="199">Huddle room</text>
        <text x="91" y="328">Restroom</text>
        <text x="549" y="328">Restroom</text>
        <text x="320" y="338">Reception & entrance</text>
      </g>
    </svg>
  )
}

/** Main workspace area: the future Canvas stage plus the session HUD. */
export function Workspace({ connection, health }) {
  const targets = describeTargets()
  const databaseStatus = health.data?.database?.status ?? '—'

  return (
    <main className="workspace">
      <section className="stage" aria-label="World stage">
        <div className="stage__header">
          <h2 className="stage__title">World stage</h2>
          <span className="stage__hint">2560 × 1600 units · canvas renderer arrives in the next milestone</span>
        </div>
        <div className="stage__viewport" id="world-canvas-host" data-testid="world-canvas-host">
          <BlueprintPlaceholder />
          <p className="stage__placeholder">
            The 2D office canvas mounts here. Avatar movement, collision and camera zoom are scheduled for the world
            rendering milestone — this session delivers the application shell only.
          </p>
        </div>
      </section>

      <aside className="hud" aria-label="Session details">
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
