import { useEffect, useState } from 'react'
import { MIC_STATE } from '../audio/audioEngine.js'
import { LIMITS } from '../../../shared/protocol.js'

/** Plain-language description of the shared AudioContext, for the panel footer. */
function contextLabel(context) {
  switch (context?.state) {
    case 'running':
      return context.hasStereoPanner ? 'running · stereo panning on' : 'running · no stereo panning'
    case 'suspended':
      return 'suspended — press the microphone button to start it'
    case 'unavailable':
      return 'unavailable — audio plays without attenuation'
    case 'idle':
      return 'not started yet'
    default:
      return context?.state ?? 'unknown'
  }
}

/**
 * Audio panel: the microphone control and the state of every voice connection.
 *
 * Two rules shape this component:
 *
 *  1. The microphone is requested **only** when the user presses the button —
 *     `enable()` is called from the click handler and never from an effect.
 *  2. Everything shown here comes from the audio engine's snapshot (which the server
 *     feeds through `audio:peer` / `audio:status`), so the UI cannot claim a call is
 *     up when the server has not authorized it.
 */
export function AudioPanel({ audio, connection }) {
  const connected = connection?.status === 'connected'
  const mic = audio?.mic ?? MIC_STATE.IDLE
  const peers = audio?.peers ?? []
  const [busy, setBusy] = useState(false)

  // A permission prompt can stay open for a while; show that we are waiting rather
  // than appearing to ignore the click.
  useEffect(() => {
    if (mic !== MIC_STATE.REQUESTING) setBusy(false)
  }, [mic])

  const micActive = mic === MIC_STATE.ACTIVE
  const muted = Boolean(audio?.muted)
  // A permission prompt that is open (or a click we are still waiting on) is a state
  // the button has to reflect, or the UI looks frozen.
  const waiting = mic === MIC_STATE.REQUESTING || busy

  const speaking = peers.filter((peer) => peer.speaking && peer.state === 'connected').length
  const connecting = peers.filter((peer) => peer.state === 'connecting').length
  const failed = peers.filter((peer) => peer.state === 'failed')
  const radius = audio?.listeningRadius ?? LIMITS.PROXIMITY_RADIUS
  const context = audio?.audioContext ?? null
  // Peers mixed through the managed Web Audio graph vs. the plain fallback. Shown
  // because it is the difference between "you are hearing distance" and "you are
  // hearing a flat stream".
  const graphStreams = peers.filter((peer) => peer.usesGraph).length
  const plainStreams = peers.length - graphStreams

  function handleMic() {
    if (micActive) {
      audio?.disable?.()
      return
    }
    setBusy(true)
    // Not awaited: the engine reports progress through its snapshot.
    audio?.enable?.()
  }

  return (
    <section className="panel" data-testid="audio-panel">
      <h3 className="panel__title">Voice</h3>

      <div className="audio__controls">
        <button
          type="button"
          className={micActive ? 'chip-button chip-button--primary' : 'chip-button'}
          data-testid="mic-toggle"
          onClick={handleMic}
          disabled={!connected || waiting}
          aria-pressed={micActive}
        >
          {micActive ? 'Microphone on' : 'Enable microphone'}
        </button>

        <button
          type="button"
          className={muted ? 'chip-button chip-button--warn' : 'chip-button'}
          data-testid="mute-toggle"
          onClick={() => audio?.toggleMute?.()}
          disabled={!micActive}
          aria-pressed={muted}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      {/*
        A visible, non-colour-only indication that the microphone is live: the dot
        pulses with our own voice activity, and the text says so in words.
      */}
      <p className="audio__status" data-testid="mic-status" aria-live="polite">
        <span
          className={[
            'audio__dot',
            micActive && !muted ? 'audio__dot--live' : '',
            micActive && audio?.speaking ? 'audio__dot--speaking' : '',
            mic === MIC_STATE.REQUESTING ? 'audio__dot--pending' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
        {mic === MIC_STATE.ACTIVE
          ? muted
            ? 'Microphone active — muted. Nobody can hear you.'
            : 'Microphone active — people nearby can hear you.'
          : mic === MIC_STATE.REQUESTING
            ? 'Waiting for microphone permission…'
            : mic === MIC_STATE.IDLE
              ? 'Microphone off. Nothing is captured.'
              : 'Microphone unavailable.'}
      </p>

      {audio?.micError ? (
        <p className="panel__error" data-testid="mic-error" role="alert">
          {audio.micError}
        </p>
      ) : null}

      {audio?.error ? (
        <p className="panel__error" data-testid="audio-error" role="alert">
          {audio.error}
        </p>
      ) : null}

      <p className="panel__note" data-testid="audio-summary">
        {(peers.length === 0
          ? 'No voice connections. Walk within earshot of somebody with their microphone on.'
          : `${peers.length} voice connection${peers.length === 1 ? '' : 's'}` +
            `${speaking > 0 ? ` · ${speaking} speaking` : ''}` +
            `${connecting > 0 ? ` · ${connecting} connecting` : ''}`) + ` · listening radius ${radius} u`}
      </p>

      {peers.length > 0 ? (
        <ul className="audio__peers" data-testid="audio-peers">
          {peers.map((peer) => (
            <li key={peer.id} className={`audio__peer audio__peer--${peer.state}`} data-testid={`audio-peer-${peer.id}`}>
              <span
                className={[
                  'audio__dot',
                  peer.state === 'connected' ? 'audio__dot--live' : '',
                  peer.state === 'connecting' ? 'audio__dot--pending' : '',
                  peer.speaking ? 'audio__dot--speaking' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
              <span className="audio__peer-name">{peer.name ?? 'Someone nearby'}</span>
              {peer.muted ? <span className="audio__badge" data-testid={`audio-peer-muted-${peer.id}`}>muted</span> : null}
              {peer.state === 'connected' ? (
                <span
                  className="audio__meter"
                  data-testid={`audio-peer-level-${peer.id}`}
                  data-level={peer.volumePercent ?? 0}
                  title={`distance ${peer.distance ?? '?'} u · heard at ${peer.volumePercent ?? 0}%`}
                >
                  <span className="audio__meter-fill" style={{ width: `${peer.volumePercent ?? 0}%` }} aria-hidden="true" />
                  <span className="audio__meter-text">
                    {peer.distance ?? '—'} u · {peer.volumePercent ?? 0}%
                  </span>
                </span>
              ) : null}
              <span className="audio__peer-state" data-testid={`audio-peer-state-${peer.id}`}>
                {peer.state === 'connected'
                  ? peer.speaking
                    ? 'speaking'
                    : 'connected'
                  : peer.state === 'connecting'
                    ? 'connecting…'
                    : peer.state}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        The audio engine, in words. "Distance is a world-unit number" is the one thing
        a reader of this panel should never have to guess.
      */}
      <dl className="kv kv--tight" data-testid="audio-engine">
        <dt>Audio engine</dt>
        <dd data-testid="audio-engine-state">
          {contextLabel(context)}
          {context?.state === 'running' && context.sampleRate ? ` · ${context.sampleRate} Hz` : ''}
        </dd>
        <dt>Distance curve</dt>
        <dd>linear · full volume to {Math.round(radius / 2)} u, silent at {radius} u (world units)</dd>
        <dt>Spatial graph</dt>
        <dd data-testid="audio-engine-graph">
          {peers.length === 0
            ? 'no remote streams'
            : `${graphStreams} of ${peers.length} stream${peers.length === 1 ? '' : 's'} through the spatial graph` +
              (plainStreams > 0 ? ` · ${plainStreams} plain (no attenuation)` : '')}
        </dd>
      </dl>

      {failed.length > 0 ? (
        <p className="panel__error" data-testid="audio-failed" role="alert">
          {`${failed.length} voice connection${failed.length === 1 ? '' : 's'} failed`}
          {audio?.hasTurn === false ? ' — no TURN relay is configured, which some networks require.' : '.'}
        </p>
      ) : null}
    </section>
  )
}
