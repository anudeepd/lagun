import { useState } from 'react'
import { Wifi, MoreVertical, Edit, Trash2, Terminal } from 'lucide-react'
import clsx from 'clsx'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import SessionForm from './SessionForm'
import ConfirmDialog from '../ui/ConfirmDialog'
import type { Session } from '../../types'
import { LoadingState } from '../ui/Spinner'
import Tooltip from '../ui/Tooltip'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, spatialTransition, surfaceTransition } from '../../motion/tokens'
import { AnimatePresence } from 'motion/react'

export default function SessionList() {
  const sessions = useSessionStore(s => s.sessions)
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const setActiveSession = useSessionStore(s => s.setActiveSession)
  const deleteSession = useSessionStore(s => s.deleteSession)
  const loading = useSessionStore(s => s.loading)
  const openQueryTab = useTabStore(s => s.openQueryTab)
  const [editSession, setEditSession] = useState<Session | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    await deleteSession(deleteTarget.id)
    setDeleteTarget(null)
  }

  if (loading && sessions.length === 0) {
    return <LoadingState label="Loading connections…" compact className="px-3 py-4" />
  }

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-muted">
        No connections yet.
      </div>
    )
  }

  return (
    <div className="py-1">
      {sessions.map(s => (
        <m.div
          key={s.id}
          layout="position"
          className={clsx(
            'relative flex items-center pl-3 pr-1 py-0.5 group transition-colors',
            activeSessionId === s.id
              ? 'text-brand-300'
              : 'hover:bg-surface-800 text-slate-300'
          )}
        >
          {activeSessionId === s.id && (
            <m.div
              layoutId="active-connection"
              transition={spatialTransition}
              className="absolute inset-0 border-l-2 border-brand-500 bg-brand-600/20"
            />
          )}
          {/* The row's primary action is a real button so the connection list is
              reachable by keyboard. The action menu stays a sibling: a button may
              not contain another button. */}
          <button
            type="button"
            onClick={() => setActiveSession(s.id)}
            aria-current={activeSessionId === s.id ? 'true' : undefined}
            className="relative flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <Wifi size={12} className="flex-shrink-0 text-green-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-xs">{s.name}</span>
            <span className="text-muted text-xs">{s.host}</span>
          </button>

          {/* Context menu trigger */}
          <div className="relative flex-shrink-0">
            <Tooltip label={`Actions for ${s.name}`}>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); setMenuId(menuId === s.id ? null : s.id) }}
              aria-label={`Actions for ${s.name}`}
              aria-haspopup="menu"
              aria-expanded={menuId === s.id}
              className="lagun-hit-target opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 rounded hover:bg-surface-700 text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <MoreVertical size={12} aria-hidden="true" />
            </button>
            </Tooltip>
            <AnimatePresence>
            {menuId === s.id && (
              <m.div
                initial={{ opacity: 0, scale: 0.9, y: -motionDistance.surface }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: surfaceTransition }}
                exit={{ opacity: 0, scale: 0.92, y: -motionDistance.subtle, transition: exitTransition }}
                role="menu"
                aria-label={`Actions for ${s.name}`}
                className="absolute right-0 top-6 z-popover w-40 rounded border border-surface-700 bg-surface-800 py-1 shadow-lg"
                onMouseLeave={() => setMenuId(null)}
              >
                {!s.managed && <button
                  role="menuitem"
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                  onClick={e => { e.stopPropagation(); openQueryTab(s.id); setMenuId(null) }}
                >
                  <Terminal size={12} aria-hidden="true" /> New Query
                </button>}
                <button
                  role="menuitem"
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                  onClick={e => { e.stopPropagation(); setEditSession(s); setMenuId(null) }}
                >
                  <Edit size={12} aria-hidden="true" /> Edit
                </button>
                <button
                  role="menuitem"
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-red-400"
                  onClick={e => { e.stopPropagation(); setDeleteTarget(s); setMenuId(null) }}
                >
                  <Trash2 size={12} aria-hidden="true" /> {s.managed ? 'Remove' : 'Delete'}
                </button>
              </m.div>
            )}
            </AnimatePresence>
          </div>
        </m.div>
      ))}
      <SessionForm
        open={!!editSession}
        onClose={() => setEditSession(null)}
        session={editSession ?? undefined}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Connection"
        message={deleteTarget?.managed
          ? `Remove "${deleteTarget.name}" from your connections? Other users keep access.`
          : `Delete connection "${deleteTarget?.name ?? ''}"? Saved credentials and related open tabs will be removed.`}
        confirmLabel={deleteTarget?.managed ? 'Remove' : 'Delete'}
        danger
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
