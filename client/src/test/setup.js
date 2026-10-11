/**
 * Global test setup (loaded by Vitest before every test file).
 *
 * React only applies full `act(...)` semantics — flushing effects and batching
 * updates inside `act()` — when this flag is set. Without it React logs
 * "The current testing environment is not configured to support act(...)" for
 * every component assertion, which also means updates could leak between tests.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true
