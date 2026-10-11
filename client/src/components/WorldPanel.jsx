/**
 * Live world read-out for the HUD.
 *
 * Reads the coarse world store (updated ~5 Hz by the engine), so this panel
 * re-renders a handful of times per second instead of every frame.
 */
export function WorldPanel({ world }) {
  const player = world?.player ?? { x: 0, y: 0, speed: 0, moving: false, facing: 0 }
  const facingDegrees = Math.round(((player.facing * 180) / Math.PI + 360) % 360)

  return (
    <section className="panel">
      <h3 className="panel__title">World</h3>
      <dl className="kv">
        <dt>Room</dt>
        <dd data-testid="world-zone">{world?.zoneName ?? '—'}</dd>
        <dt>Position</dt>
        <dd className="kv__mono" data-testid="world-position">
          {player.x}, {player.y}
        </dd>
        <dt>Facing</dt>
        <dd>{facingDegrees}°</dd>
        <dt>Speed</dt>
        <dd>
          {player.speed} u/s{player.moving ? ' · walking' : ' · idle'}
        </dd>
        <dt>Zoom</dt>
        <dd>{Math.round((world?.zoom ?? 1) * 100)}%</dd>
        <dt>Camera</dt>
        <dd>{world?.follow ? 'following' : 'free'}</dd>
        <dt>Frame rate</dt>
        <dd>{world?.fps ?? 0} fps</dd>
        <dt>Peers</dt>
        <dd>
          {world?.peerCount ?? 0} in world · {world?.nearbyCount ?? 0} nearby
        </dd>
      </dl>
      <p className="panel__note">
        Movement, collision and camera run in the canvas loop; this panel samples them at 5 Hz so the React tree
        never re-renders per frame.
      </p>
    </section>
  )
}
