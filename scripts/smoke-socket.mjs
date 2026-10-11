#!/usr/bin/env node
// Smoke test: verifies the HTTP health endpoint and a real Socket.IO handshake.
//
// Usage:
//   node scripts/smoke-socket.mjs                          # direct to the backend
//   SMOKE_URL=http://127.0.0.1:5173 npm run smoke:socket   # through the Vite dev proxy
//
// The proxy run is the important one: it exercises exactly the path a browser
// takes (same-origin request → Vite proxy → backend), including the Origin header.
// Exits non-zero on the first failed assertion.

import process from 'node:process'
import { io } from 'socket.io-client'

const BASE_URL = (process.env.SMOKE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const ORIGIN = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173'
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 8000)

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'
  process.stdout.write(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    timer.unref?.()
  })
}

async function checkHealth() {
  const url = `${BASE_URL}/api/health`
  const response = await fetch(url, { headers: { origin: ORIGIN } })
  const body = await response.json().catch(() => null)
  record(
    `GET ${url} → 200 JSON`,
    response.ok && body?.status === 'ok',
    `status ${response.status}, body ${JSON.stringify(body)}`,
  )
  record(
    'health payload exposes no environment values',
    typeof body === 'object' && body !== null && !JSON.stringify(body).match(/mongodb(\+srv)?:\/\/|CORS_ORIGIN|\bPORT=/i),
    'no connection strings or env names found',
  )
  const allowOrigin = response.headers.get('access-control-allow-origin')
  // Direct to the backend the header echoes the requesting origin. Through the
  // Vite dev proxy the backend sees (and echoes) the delegated development
  // origin, which is exactly what keeps CORS strict; SMOKE_EXPECTED_ALLOW_ORIGIN
  // documents that case.
  const expectedAllowOrigin = process.env.SMOKE_EXPECTED_ALLOW_ORIGIN ?? ORIGIN
  record(
    'CORS header for the allowed origin',
    allowOrigin === expectedAllowOrigin,
    `Access-Control-Allow-Origin: ${allowOrigin ?? '(none)'} (expected ${expectedAllowOrigin})`,
  )
}

async function checkSocket() {
  const socket = io(BASE_URL, {
    transports: ['websocket', 'polling'],
    extraHeaders: { origin: ORIGIN },
    reconnection: false,
    timeout: TIMEOUT_MS,
  })

  const outcome = await Promise.race([
    new Promise((resolve) => {
      socket.on('connect', () => resolve({ ok: true, id: socket.id, transport: socket.io.engine.transport.name }))
      socket.on('connect_error', (error) => resolve({ ok: false, error: error.message }))
    }),
    timeout(TIMEOUT_MS, 'socket handshake').then(
      () => ({ ok: false, error: 'timeout' }),
      (error) => ({ ok: false, error: error.message }),
    ),
  ])

  record(
    `Socket.IO handshake with ${BASE_URL}`,
    outcome.ok === true,
    outcome.ok ? `id ${outcome.id}, transport ${outcome.transport}` : `error: ${outcome.error}`,
  )

  if (outcome.ok) {
    const disconnected = await Promise.race([
      new Promise((resolve) => {
        socket.once('disconnect', (reason) => resolve(reason))
        // Trigger the disconnect we are waiting for.
        socket.close()
      }),
      timeout(TIMEOUT_MS, 'socket disconnect').then(
        () => 'timeout',
        () => 'timeout',
      ),
    ])
    record(
      'clean client-side disconnect',
      disconnected !== 'timeout' && disconnected !== 'timeout',
      `reason: ${disconnected}`,
    )
  }

  socket.close()
}

async function main() {
  process.stdout.write(`\nProxiSpeak smoke test\n  target: ${BASE_URL}\n  origin: ${ORIGIN}\n\n`)
  try {
    await checkHealth()
  } catch (error) {
    record('GET /api/health', false, error.message)
  }
  try {
    await checkSocket()
  } catch (error) {
    record('Socket.IO connection', false, error.message)
  }

  const failed = results.filter((result) => !result.ok)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
  if (failed.length > 0) {
    process.stdout.write('Is the backend running? Try: npm run dev:server\n\n')
    process.exit(1)
  }
  process.stdout.write('\n')
}

main().catch((error) => {
  process.stderr.write(`smoke test crashed: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
