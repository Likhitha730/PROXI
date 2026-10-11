import { env } from '../config/env.js'
import { ConnectionBadge } from './ConnectionBadge.jsx'

/** Application chrome: product identity on the left, live status on the right. */
export function AppHeader({ connection, health, presence }) {
  const backendLabel =
    health.status === 'ok' ? 'Backend online' : health.status === 'loading' ? 'Checking backend…' : 'Backend offline'

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__mark" aria-hidden="true">
          PS
        </span>
        <span className="app-header__titles">
          <span className="app-header__title">{env.appName}</span>
          <span className="app-header__subtitle">Real-time virtual office · proximity voice</span>
        </span>
      </div>

      <div className="app-header__status">
        <div className={`chip chip--${health.status}`} role="status" aria-live="polite">
          <span className={`chip__dot chip__dot--${health.status}`} aria-hidden="true" />
          {backendLabel}
        </div>
        <div className="chip chip--players" role="status" aria-live="polite" data-testid="header-player-count">
          <span className="chip__dot chip__dot--players" aria-hidden="true" />
          {presence?.count ?? 0} online
        </div>
        <ConnectionBadge connection={connection} />
      </div>
    </header>
  )
}
