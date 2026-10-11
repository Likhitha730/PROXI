const LABELS = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection error',
}

/** Header indicator for the live Socket.IO connection. */
export function ConnectionBadge({ connection }) {
  const { status, transport, socketId } = connection
  const label = LABELS[status] ?? status

  return (
    <div className={`badge badge--${status}`} role="status" aria-live="polite" title={socketId ? `Socket ${socketId}` : label}>
      <span className={`badge__dot badge__dot--${status}`} aria-hidden="true" />
      <span className="badge__label">{label}</span>
      {status === 'connected' && transport ? <span className="badge__meta">{transport}</span> : null}
    </div>
  )
}
