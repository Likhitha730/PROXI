import { useEffect, useState } from 'react'
import { getDisplayName, setDisplayName } from '../net/socketClient.js'
import { LIMITS } from '../../../shared/protocol.js'

/**
 * Presence panel: who is in the office, and the display name we introduce
 * ourselves with.
 *
 * It reads the coarse presence snapshot, so it re-renders when someone joins,
 * leaves or renames — never on a movement event. The name field is a normal
 * input: the keyboard module ignores typing targets, so editing this while the
 * avatar walks is safe (and the test suite asserts exactly that).
 */
export function PresencePanel({ presence, connection, onDismissError }) {
  const [draft, setDraft] = useState(() => getDisplayName())
  const [editing, setEditing] = useState(false)

  // Keep the field in sync when the name changes elsewhere (a rename elsewhere
  // in the app, or a reconnect that loads a stored name).
  useEffect(() => {
    if (!editing) setDraft(getDisplayName())
  }, [editing, presence?.self?.name])

  const connected = connection?.status === 'connected'
  const self = presence?.self ?? null
  const others = presence?.players ?? []

  function applyName(event) {
    event.preventDefault()
    setDisplayName(draft)
    setEditing(false)
  }

  return (
    <section className="panel">
      <h3 className="panel__title">Players</h3>

      <p className="presence__count" data-testid="presence-count" aria-live="polite">
        <strong>{presence?.count ?? 0}</strong> in the office
        {presence?.room ? <span className="presence__room"> · {presence.room.id}</span> : null}
      </p>

      <form className="presence__name" onSubmit={applyName}>
        <label className="presence__label" htmlFor="display-name">
          Display name
        </label>
        <div className="presence__name-row">
          <input
            id="display-name"
            data-testid="display-name-input"
            className="presence__input"
            value={draft}
            maxLength={LIMITS.NAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck="false"
            onChange={(event) => {
              setEditing(true)
              setDraft(event.target.value)
            }}
            onBlur={() => setEditing(false)}
          />
          <button
            type="submit"
            className="chip-button"
            data-testid="display-name-apply"
            disabled={!connected || draft.trim() === getDisplayName()}
          >
            Apply
          </button>
        </div>
        <p className="panel__note">
          {connected
            ? self
              ? `Joined as ${self.name} · session ${String(self.id).slice(0, 8)}`
              : 'Joining the room…'
            : 'Not connected — the name is stored locally and used on connect.'}
        </p>
      </form>

      <ul className="presence__list" data-testid="presence-roster">
        {others.length === 0 ? (
          <li className="presence__empty">No one else here yet — open a second window to see them.</li>
        ) : (
          others.map((player) => (
            <li key={player.id} className="presence__item">
              <span className="presence__dot" aria-hidden="true" />
              <span className="presence__player">{player.name}</span>
            </li>
          ))
        )}
      </ul>

      {presence?.lastError ? (
        <p className="panel__error" data-testid="presence-error">
          {presence.lastError.message}{' '}
          <button type="button" className="link-button" onClick={onDismissError}>
            dismiss
          </button>
        </p>
      ) : null}
    </section>
  )
}
