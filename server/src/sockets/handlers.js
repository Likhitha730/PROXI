// Socket.IO connection handling for this milestone.
//
// Scope: a safe connection/disconnection handshake with structured logging.
// Presence, position sync, proximity and WebRTC signalling are intentionally NOT
// implemented yet (they belong to the realtime milestones). Unknown events are
// ignored by design — no listeners are registered for them, so a malformed or
// hostile client cannot trigger application logic.

const TRANSPORT_UPGRADE = 'upgrade'

function connectionMeta(socket) {
  return {
    socketId: socket.id,
    transport: socket.conn?.transport?.name ?? 'unknown',
    // Origin is the only header we surface; the rest of the handshake (cookies,
    // auth headers, query strings) is deliberately never logged.
    origin: socket.handshake?.headers?.origin ?? null,
    clientIp: socket.handshake?.address ?? null,
  }
}

export function registerSocketHandlers(io, { logger, config }) {
  const log = logger.child('socket')

  io.on('connection', (socket) => {
    const meta = connectionMeta(socket)
    log.info('socket connected', meta)

    socket.conn?.on(TRANSPORT_UPGRADE, (transport) => {
      log.debug('transport upgraded', { socketId: socket.id, transport: transport?.name ?? 'unknown' })
    })

    socket.on('error', (error) => {
      log.warn('socket error', { socketId: socket.id, reason: error?.message })
    })

    socket.on('disconnect', (reason) => {
      log.info('socket disconnected', { socketId: socket.id, reason })
    })
  })

  if (config?.corsOrigins?.includes('*')) {
    log.warn('CORS_ORIGIN is set to "*" — every origin may connect. Use exact origins outside local experiments.')
  }
}
