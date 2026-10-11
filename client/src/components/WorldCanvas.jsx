import { useEffect, useRef, useState } from 'react'
import { createWorldEngine } from '../render/engine.js'
import { worldStore } from '../state/worldStore.js'
import { presence } from '../net/presence.js'
import { sendMove } from '../net/socketClient.js'

/**
 * Mounts the canvas and owns the engine lifecycle.
 *
 * The engine is created once per mount and destroyed on unmount, which cancels
 * the animation frame, detaches every listener and disconnects the resize
 * observer. React never re-renders per animation frame — the engine reports into
 * `worldStore` at ~5 Hz and the HUD subscribes to that.
 *
 * Network integration is three callbacks, so the engine itself stays unaware of
 * Socket.IO:
 *   peerProvider     -> interpolated remote players, read every frame
 *   stateReporter    -> our own movement, published at <=15 Hz
 *   correctionSource -> authoritative position pushed by the server
 */
export function WorldCanvas({ playerName = 'You', spawnId, onEngineReady }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return undefined

    let engine
    try {
      engine = createWorldEngine({ canvas, container, store: worldStore, playerName, spawnId })
      engine.setPeerProvider((now) => presence.collectPeers(now))
      engine.setStateReporter((state) => sendMove(state))
      engine.setCorrectionSource(() => presence.takeCorrection())
      engine.start()
      onEngineReady?.(engine)
      setError(null)
    } catch (cause) {
      setError(cause?.message ?? 'The world renderer failed to start')
      return undefined
    }

    return () => {
      engine?.destroy()
      onEngineReady?.(null)
    }
    // The engine is intentionally created once per mount: player name and spawn
    // are the only inputs, and both are stable for a session.
  }, [playerName, spawnId, onEngineReady])

  return (
    <div
      className="stage__viewport"
      id="world-canvas-host"
      data-testid="world-canvas-host"
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="Office world. Use W A S D or the arrow keys to walk."
    >
      <canvas ref={canvasRef} className="world-canvas" data-testid="world-canvas" />
      {error ? (
        <div className="stage__error" role="alert">
          <strong>Renderer error.</strong> {error}
        </div>
      ) : null}
      <p className="stage__hintbar" aria-hidden="true">
        <span>
          <kbd>W</kbd>
          <kbd>A</kbd>
          <kbd>S</kbd>
          <kbd>D</kbd> walk
        </span>
        <span>
          <kbd>wheel</kbd> zoom
        </span>
        <span>
          <kbd>drag</kbd> pan
        </span>
        <span>
          <kbd>R</kbd> reset camera
        </span>
      </p>
    </div>
  )
}
