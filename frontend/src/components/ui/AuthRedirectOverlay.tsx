import { useEffect, useState } from 'react'
import {
  AUTH_LOGOUT_EVENT,
  AUTH_REDIRECT_EVENT,
  redirectToLdapLoginNow,
} from '../../utils/authRedirect'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, surfaceTransition } from '../../motion/tokens'

type AuthOverlayMode = 'expired' | 'logout'

const COPY: Record<AuthOverlayMode, { title: string; message: string; action?: string }> = {
  expired: {
    title: 'Session expired',
    message: 'Your session has ended. Redirecting to sign in...',
    action: 'Sign in now',
  },
  logout: {
    title: 'Signing out',
    message: 'Ending your session...',
  },
}

export default function AuthRedirectOverlay() {
  const [mode, setMode] = useState<AuthOverlayMode | null>(null)

  useEffect(() => {
    const showExpired = () => setMode('expired')
    const showLogout = () => setMode('logout')
    window.addEventListener(AUTH_REDIRECT_EVENT, showExpired)
    window.addEventListener(AUTH_LOGOUT_EVENT, showLogout)
    return () => {
      window.removeEventListener(AUTH_REDIRECT_EVENT, showExpired)
      window.removeEventListener(AUTH_LOGOUT_EVENT, showLogout)
    }
  }, [])

  const copy = mode ? COPY[mode] : null
  const hasAction = Boolean(copy?.action)

  return (
    <AnimatePresence>
    {mode && copy && (
    <m.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: surfaceTransition }} exit={{ opacity: 0, transition: exitTransition }} className="fixed inset-0 z-critical flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <m.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: surfaceTransition }} className="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900/95 p-5 shadow-2xl">
        <div className={hasAction ? 'mb-4 flex items-center gap-3' : 'flex items-center gap-3'}>
          <div className="h-9 w-9 rounded-full border border-brand-500/40 bg-brand-500/10 p-2">
            <div className="h-full w-full animate-pulse rounded-full bg-brand-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{copy.title}</h2>
            <p className="mt-1 text-xs text-slate-400">{copy.message}</p>
          </div>
        </div>
        {hasAction && (
          <button
            type="button"
            onClick={redirectToLdapLoginNow}
            className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {copy.action}
          </button>
        )}
      </m.div>
    </m.div>
    )}
    </AnimatePresence>
  )
}
