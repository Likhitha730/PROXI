import { useEffect } from 'react'
import { AppHeader } from './components/AppHeader.jsx'
import { AppFooter } from './components/AppFooter.jsx'
import { Workspace } from './components/Workspace.jsx'
import { StatusOverlay } from './components/StatusOverlay.jsx'
import { connect, destroySocket } from './net/socketClient.js'
import { useBackendHealth, useConnection } from './state/hooks.js'

export default function App() {
  const connection = useConnection()
  const health = useBackendHealth()

  // Opening the shell opens the realtime session. `connect` is idempotent, so the
  // double effect invocation of React StrictMode in development is harmless.
  useEffect(() => {
    connect()
  }, [])

  useEffect(() => {
    const close = () => destroySocket()
    window.addEventListener('beforeunload', close)
    return () => window.removeEventListener('beforeunload', close)
  }, [])

  return (
    <div className="app-shell">
      <AppHeader connection={connection} health={health} />
      <Workspace connection={connection} health={health} />
      <AppFooter connection={connection} health={health} />
      <StatusOverlay connection={connection} health={health} />
    </div>
  )
}
