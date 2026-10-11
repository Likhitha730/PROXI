import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the backend the dev server proxies to.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8080'

// The origin the backend's CORS allow-list expects for local development.
const DEV_FRONTEND_ORIGIN = process.env.DEV_FRONTEND_ORIGIN ?? 'http://localhost:5173'

// The browser only ever talks to the Vite origin (port 5173). Vite forwards REST
// and Socket.IO traffic to the backend, which keeps the browser free of
// cross-origin requests (so CORS never applies to the browser) and lets the
// backend keep a strict allow-list.
//
// `headers.origin` re-stamps the request with the documented development origin.
// The dev proxy is the trusted boundary of the browser session, and this is what
// makes the app work from any host the browser happens to use — localhost, a LAN
// address, a tunnel or a hosted preview domain — without weakening the server's
// CORS policy or adding wildcard origins.
function backendProxy(extra = {}) {
  return {
    target: BACKEND_ORIGIN,
    changeOrigin: true,
    headers: { origin: DEV_FRONTEND_ORIGIN },
    ...extra,
  }
}

const proxy = {
  '/api': backendProxy(),
  '/socket.io': backendProxy({ ws: true }),
}

export default defineConfig({
  plugins: [react()],
  server: {
    // Hard requirement: always port 5173, never silently pick another port.
    port: 5173,
    strictPort: true,
    // Bind all interfaces so the app also works behind a container/proxy host
    // (localhost alone would be unreachable there).
    host: true,
    // The dev host is not known in advance when running behind a preview proxy.
    allowedHosts: true,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: true,
    proxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
