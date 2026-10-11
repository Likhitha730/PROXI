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
        <dt>Motion</dt>
        <dd data-testid="world-motion">{world?.reducedMotion ? 'reduced (system preference)' : 'full'}</dd>
      </dl>

      {/*
        Selected-avatar card: the distance is world-space and the percentage is the
        level the spatial graph is mixing that stream at, so the number under the
        name is literally what you are hearing.
      */}
      <div className="focus-card" data-testid="focus-card">
        {world?.selected ? (
          <>
            <p className="focus-card__name" data-testid="focus-name">
              {world.selected.name}
              {world.selected.isLocal ? ' (you)' : ''}
            </p>
            <p className="focus-card__detail" data-testid="focus-detail">
              {world.selected.isLocal
                ? 'Walking around in your own listening radius.'
                : `${world.selected.distance ?? '—'} u away · heard at ${world.selected.volumePercent ?? 0}%` +
                  (world.selected.nearby ? ' · in earshot' : ' · out of earshot') +
                  (world.selected.muted ? ' · muted' : '')}
            </p>
            {!world.selected.isLocal && Number.isFinite(world.selected.volumePercent) ? (
              <span className="audio__meter focus-card__meter" data-testid="focus-level" data-level={world.selected.volumePercent}>
                <span className="audio__meter-fill" style={{ width: `${world.selected.volumePercent}%` }} aria-hidden="true" />
              </span>
            ) : null}
          </>
        ) : (
          <p className="focus-card__hint">Click an avatar to inspect it — hover shows its name, distance and volume.</p>
        )}
      </div>
      <p className="panel__note">
        Movement, collision and camera run in the canvas loop; this panel samples them at 5 Hz so the React tree
        never re-renders per frame.
      </p>
    </section>
  )
}
