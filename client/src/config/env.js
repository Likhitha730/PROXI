// Single, validated entry point for build-time environment values.
//
// Rules:
//  - Every value has a documented local-development default, so the app runs
//    with no `.env` file at all.
//  - Nothing here reads from `process` or from the server; anything prefixed
//    with VITE_ is inlined into the bundle by Vite and must therefore never
//    hold a secret.

const DEFAULTS = Object.freeze({
  socketUrl: '', // '' → same origin (Vite proxy in dev, Express in production)
  apiUrl: '', // '' → same origin
  appName: 'ProxiSpeak',
  /*
   * ICE overrides. Normally EMPTY: the server hands out its ICE configuration at
   * /api/ice, which keeps TURN credentials out of this bundle (anything VITE_* is
   * inlined into the shipped JavaScript and readable by anyone). Set these only for
   * local experiments against a relay you control — and never with a long-lived
   * credential. See docs/ARCHITECTURE.md §8.
   */
  iceStunUrls: '',
  iceTurnUrl: '',
  iceTurnUsername: '',
  iceTurnCredential: '',
})

/*
 * `import.meta.env` only exists under Vite: it is undefined when a client module is
 * imported by plain Node — which is exactly what the verification scripts do
 * (`scripts/verify-audio.mjs` drives the real audio engine headlessly). Falling
 * back to an empty object keeps those scripts working without a build step.
 */
const viteEnv = import.meta.env ?? {}

function readString(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '')
}

export const env = Object.freeze({
  mode: viteEnv.MODE ?? 'test',
  isDev: Boolean(viteEnv.DEV),
  isProd: Boolean(viteEnv.PROD),
  appName: readString(viteEnv.VITE_APP_NAME, DEFAULTS.appName),
  socketUrl: stripTrailingSlash(readString(viteEnv.VITE_SOCKET_URL, DEFAULTS.socketUrl)),
  apiUrl: stripTrailingSlash(readString(viteEnv.VITE_API_URL, DEFAULTS.apiUrl)),
  iceStunUrls: readString(viteEnv.VITE_ICE_STUN_URLS, DEFAULTS.iceStunUrls),
  iceTurnUrl: readString(viteEnv.VITE_ICE_TURN_URL, DEFAULTS.iceTurnUrl),
  iceTurnUsername: readString(viteEnv.VITE_ICE_TURN_USERNAME, DEFAULTS.iceTurnUsername),
  iceTurnCredential: readString(viteEnv.VITE_ICE_TURN_CREDENTIAL, DEFAULTS.iceTurnCredential),
})

/**
 * Build an absolute REST URL. With the default (same-origin) configuration this
 * returns a relative path such as `/api/health`, which is what we want in both
 * dev (proxied) and production (served by Express).
 */
export function apiUrl(path) {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${env.apiUrl}${suffix}`
}

/** Where a human can look for the Socket.IO endpoint currently in use. */
export function describeTargets() {
  return {
    socket: env.socketUrl.length > 0 ? env.socketUrl : 'same origin (/socket.io)',
    api: env.apiUrl.length > 0 ? env.apiUrl : 'same origin (/api)',
  }
}
