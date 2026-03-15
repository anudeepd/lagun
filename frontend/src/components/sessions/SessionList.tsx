import { useState } from 'react'
import { Wifi, WifiOff, MoreVertical, Edit, Trash2, Terminal } from 'lucide-react'
import clsx from 'clsx'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import SessionForm from './SessionForm'
import type { Session } from '../../types'

interface Props {
  onNew: () => void
}

export default function SessionList({ onNew }: Props) {
  const { sessions, activeSessionId, setActiveSession, deleteSession } = useSessionStore()
  const { openQueryTab } = useTabStore()
  const [editSession, setEditSession] = useState<Session | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-slate-500">
        No connections yet.
      </div>
    )
  }

  return (
    <div className="py-1">
      {sessions.map(s => (
        <div
          key={s.id}
          className={clsx(
            'flex items-center px-3 py-1.5 cursor-pointer group transition-colors',
            activeSessionId === s.id
              ? 'bg-brand-600/20 text-brand-300'
              : 'hover:bg-surface-800 text-slate-300'
          )}
          onClick={() => setActiveSession(s.id)}
        >
          <Wifi size={12} className="flex-shrink-0 mr-2 text-green-400" />
          <span className="flex-1 truncate text-xs">{s.name}</span>
          <span className="text-slate-500 text-xs mr-1">{s.host}</span>

          {/* Context menu trigger */}
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setMenuId(menuId === s.id ? null : s.id) }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-surface-700 text-slate-400 hover:text-slate-200"
            >
              <MoreVertical size={12} />
            </button>
            {menuId === s.id && (
              <div
                className="absolute right-0 top-6 bg-surface-800 border border-surface-700 rounded shadow-lg z-50 py-1 w-40"
                onMouseLeave={() => setMenuId(null)}
              >
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                  onClick={e => { e.stopPropagation(); openQueryTab(s.id); setMenuId(null) }}
                >
                  <Terminal size={12} /> New Query
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                  onClick={e => { e.stopPropagation(); setEditSession(s); setMenuId(null) }}
                >
                  <Edit size={12} /> Edit
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-red-400"
                  onClick={e => { e.stopPropagation(); deleteSession(s.id); setMenuId(null) }}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
      {editSession && (
        <SessionForm
          open={!!editSession}
          onClose={() => setEditSession(null)}
          session={editSession}
        />
      )}
    </div>
  )
}
