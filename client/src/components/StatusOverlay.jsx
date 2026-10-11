import { retry } from '../net/socketClient.js'
import { describeTargets } from '../config/env.js'

/**
 * Blocking states for the shell:
 *  - loading: first handshake in progress (clear loading state)
 *  - offline: backend unreachable or the socket dropped (clear disconnected state)
 * When the socket is connected this renders nothing.
 */
export function StatusOverlay({ connection, health }) {
  const { status, lastError, disconnectedReason, socketId } = connection
  const everConnected = Boolean(socketId) || Boolean(connection.connectedAt)

  if (status === 'connected') return null

  const isLoading = status === 'idle' || (status === 'connecting' && !everConnected)
  if (isLoading) {
    return (
      <div className="overlay" role="status" aria-live="polite">
        <div className="overlay__card">
          <span className="spinner" aria-hidden="true" />
          <h2 className="overlay__title">Connecting to the workspace…</h2>
          <p className="overlay__text">
            Establishing the realtime session with the backend at <code>{describeTargets().socket}</code>.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'connecting') {
    return (
      <div className="overlay" role="status" aria-live="polite">
        <div className="overlay__card">
          <span className="spinner" aria-hidden="true" />
          <h2 className="overlay__title">Reconnecting…</h2>
          <p className="overlay__text">The realtime session dropped. Retrying with exponential backoff.</p>
        </div>
      </div>
    )
  }

  // status === 'error' | 'disconnected'
  return (
    <div className="overlay overlay--error" role="alertdialog" aria-labelledby="offline-title">
      <div className="overlay__card">
        <span className="overlay__icon" aria-hidden="true">
          !
        </span>
        <h2 className="overlay__title" id="offline-title">
          Backend unreachable
        </h2>
        <p className="overlay__text">
          {lastError ?? `The connection to the server was closed${disconnectedReason ? ` (${disconnectedReason})` : ''}.`}
        </p>
        <ul className="overlay__hints">
          <li>
            Start the API and Socket.IO server: <code>npm run dev:server</code> (port 8080)
          </li>
          <li>
            Or start both together from the repository root: <code>npm run dev</code>
          </li>
          <li>
            Health endpoint: <code>/api/health</code> {health.status === 'error' ? '· not responding' : ''}
          </li>
        </ul>
        <button type="button" className="button" onClick={() => retry()}>
          Retry connection
        </button>
      </div>
    </div>
  )
}
