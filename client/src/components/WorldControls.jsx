import { SPAWNS } from '../world/worldData.js'

function ControlButton({ label, hint, onClick, active = false, disabled = false, children }) {
  return (
    <button
      type="button"
      className={`icon-button${active ? ' icon-button--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  )
}

/**
 * Camera / view controls for the canvas.
 *
 * Every button is a real button (keyboard reachable, has an aria-label) and
 * forwards to engine methods — the engine stays the single source of truth, so
 * keyboard shortcuts and buttons can never drift apart.
 */
export function WorldControls({ engine, world }) {
  const disabled = !engine

  return (
    <div className="world-controls" role="toolbar" aria-label="World controls">
      <div className="world-controls__group">
        <ControlButton label="Zoom out" hint="Zoom out (−)" onClick={() => engine?.zoomOut()} disabled={disabled}>
          −
        </ControlButton>
        <span className="world-controls__readout" aria-live="polite">
          {Math.round((world?.zoom ?? 1) * 100)}%
        </span>
        <ControlButton label="Zoom in" hint="Zoom in (+)" onClick={() => engine?.zoomIn()} disabled={disabled}>
          +
        </ControlButton>
      </div>

      <div className="world-controls__group">
        <ControlButton
          label="Reset camera"
          hint="Reset camera and zoom (R)"
          onClick={() => engine?.resetCamera()}
          disabled={disabled}
        >
          ⌖
        </ControlButton>
        <ControlButton
          label="Follow the player"
          hint="Toggle camera follow (F)"
          onClick={() => engine?.toggleFollow()}
          active={Boolean(world?.follow)}
          disabled={disabled}
        >
          ◎
        </ControlButton>
        <ControlButton
          label="Show room labels"
          hint="Toggle room labels (L)"
          onClick={() => engine?.toggleLabels()}
          active={Boolean(world?.showLabels)}
          disabled={disabled}
        >
          ⌗
        </ControlButton>
      </div>

      <div className="world-controls__group world-controls__group--spawns">
        <span className="world-controls__label">Spawn</span>
        {SPAWNS.map((spawn, index) => (
          <button
            key={spawn.id}
            type="button"
            className="chip-button"
            onClick={() => engine?.teleportTo(spawn.id)}
            disabled={disabled}
            title={`Move to ${spawn.label} (${index + 1})`}
          >
            {spawn.label}
          </button>
        ))}
      </div>
    </div>
  )
}
