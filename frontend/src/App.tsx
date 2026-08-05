import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import AdminConsole from './components/admin/AdminConsole'
import AppLayout from './components/layout/AppLayout'
import PresenceReporter from './components/presence/PresenceReporter'
import { useSessionStore } from './store/sessionStore'
import { useTabStore } from './store/tabStore'
import { useServerConfigStore } from './store/serverConfigStore'
import AuthRedirectOverlay from './components/ui/AuthRedirectOverlay'
import ToastViewport from './components/ui/ToastViewport'
import { spatialTransition } from './motion/tokens'
import { redirectToLdapLogin } from './utils/authRedirect'
import { startAuthIdleTimer } from './utils/authIdleTimer'

export default function App() {
  const [isAdminRoute, setIsAdminRoute] = useState(() => window.location.pathname === '/admin')
  const loadSessions = useSessionStore(s => s.loadSessions)
  const loadServerConfig = useServerConfigStore(s => s.load)
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const ldapIdleTimeout = useServerConfigStore(s => s.ldapIdleTimeout)

  useEffect(() => {
    const handlePopState = () => setIsAdminRoute(window.location.pathname === '/admin')
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

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

  const navigateToAdmin = () => {
    window.history.pushState({}, '', '/admin')
    setIsAdminRoute(true)
  }

  const closeAdmin = () => {
    window.history.pushState({}, '', '/')
    setIsAdminRoute(false)
  }
  const routeDirection = isAdminRoute ? 1 : -1

  return (
    <>
      <PresenceReporter />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-critical rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-white">
        Skip to main content
      </a>
      <div className="relative h-dvh overflow-hidden">
        <AnimatePresence initial={false} mode="sync">
          {isAdminRoute ? (
            <m.div
              key="admin-route"
              initial={{ opacity: 0, x: routeDirection * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -routeDirection * 18 }}
              transition={{ ...spatialTransition, opacity: { duration: 0.2 } }}
              className="absolute inset-0"
            >
              <AdminConsole onClose={closeAdmin} />
            </m.div>
          ) : (
            <m.div
              key="workspace-route"
              initial={{ opacity: 0, x: routeDirection * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -routeDirection * 18 }}
              transition={{ ...spatialTransition, opacity: { duration: 0.2 } }}
              className="absolute inset-0"
            >
              <AppLayout navigateToAdmin={navigateToAdmin} />
            </m.div>
          )}
        </AnimatePresence>
      </div>
      <AuthRedirectOverlay />
      <ToastViewport />
    </>
  )
}
