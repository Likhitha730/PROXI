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
})

function readString(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '')
}

export const env = Object.freeze({
  mode: import.meta.env.MODE,
  isDev: Boolean(import.meta.env.DEV),
  isProd: Boolean(import.meta.env.PROD),
  appName: readString(import.meta.env.VITE_APP_NAME, DEFAULTS.appName),
  socketUrl: stripTrailingSlash(readString(import.meta.env.VITE_SOCKET_URL, DEFAULTS.socketUrl)),
  apiUrl: stripTrailingSlash(readString(import.meta.env.VITE_API_URL, DEFAULTS.apiUrl)),
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
