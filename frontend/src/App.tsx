import { useEffect } from 'react'
import AppLayout from './components/layout/AppLayout'
import { useSessionStore } from './store/sessionStore'
import { useTabStore } from './store/tabStore'
import { useServerConfigStore } from './store/serverConfigStore'
import AuthRedirectOverlay from './components/ui/AuthRedirectOverlay'
import ToastViewport from './components/ui/ToastViewport'
import { redirectToLdapLogin } from './utils/authRedirect'
import { startAuthIdleTimer } from './utils/authIdleTimer'

export default function App() {
  const loadSessions = useSessionStore(s => s.loadSessions)
  const loadServerConfig = useServerConfigStore(s => s.load)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const ldapIdleTimeout = useServerConfigStore(s => s.ldapIdleTimeout)

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
  }, [loadSessions, loadServerConfig])

  useEffect(() => startAuthIdleTimer({
    enabled: ldapEnabled,
    idleTimeoutSeconds: ldapIdleTimeout,
    onIdle: redirectToLdapLogin,
  }), [ldapEnabled, ldapIdleTimeout])

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[300] rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-white">
        Skip to main content
      </a>
      <AppLayout />
      <AuthRedirectOverlay />
      <ToastViewport />
    </>
  )
}
