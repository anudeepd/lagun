import { useEffect } from 'react'
import AppLayout from './components/layout/AppLayout'
import { useSessionStore } from './store/sessionStore'
import { useTabStore } from './store/tabStore'
import { useServerConfigStore } from './store/serverConfigStore'

export default function App() {
  const loadSessions = useSessionStore(s => s.loadSessions)
  const loadServerConfig = useServerConfigStore(s => s.load)

  useEffect(() => {
    loadServerConfig()
    loadSessions().then(() => {
      const sessionIds = new Set(useSessionStore.getState().sessions.map(s => s.id))

      // Clear activeSessionId if the session was deleted
      const { activeSessionId } = useSessionStore.getState()
      if (activeSessionId && !sessionIds.has(activeSessionId)) {
        useSessionStore.getState().setActiveSession(null)
      }

      // Close tabs belonging to deleted sessions
      const { tabs } = useTabStore.getState()
      for (const tab of tabs) {
        if (!sessionIds.has(tab.sessionId)) {
          useTabStore.getState().closeTab(tab.id)
        }
      }
    })
  }, [loadSessions])

  return <AppLayout />
}
