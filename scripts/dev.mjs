#!/usr/bin/env node
// Runs the backend and frontend dev servers together with prefixed, colour-coded
// output. No extra dependency (no concurrently / npm-run-all) — plain child_process.
//
// Usage: npm run dev
// Exit:  Ctrl+C stops both children; if either child dies unexpectedly the other
//        is stopped as well and this process exits with a non-zero code.

import { spawn } from 'node:child_process'
import process from 'node:process'

const TASKS = [
  {
    name: 'server',
    colour: '\u001b[36m', // cyan
    command: 'npm',
    args: ['--prefix', 'server', 'run', 'dev'],
  },
  {
    name: 'client',
    colour: '\u001b[35m', // magenta
    command: 'npm',
    args: ['--prefix', 'client', 'run', 'dev'],
  },
]

const RESET = '\u001b[0m'
const children = []
let shuttingDown = false

function prefixStream(stream, { name, colour }) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      process.stdout.write(`${colour}[${name}]${RESET} ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) process.stdout.write(`${colour}[${name}]${RESET} ${buffer}\n`)
  })
}

function stopAll(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(exitCode), 400)
}

for (const task of TASKS) {
  const child = spawn(task.command, task.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  children.push(child)
  prefixStream(child.stdout, task)
  prefixStream(child.stderr, task)

  child.on('error', (error) => {
    process.stderr.write(`${task.colour}[${task.name}]${RESET} failed to start: ${error.message}\n`)
    stopAll(1)
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    const detail = signal ? `signal ${signal}` : `code ${code}`
    process.stderr.write(`${task.colour}[${task.name}]${RESET} exited unexpectedly (${detail})\n`)
    stopAll(code === 0 ? 1 : code ?? 1)
  })
}

process.on('SIGINT', () => {
  process.stdout.write('\nStopping dev servers…\n')
  stopAll(0)
})
process.on('SIGTERM', () => stopAll(0))

process.stdout.write('ProxiSpeak dev — starting backend (8080) and frontend (5173)\n')
