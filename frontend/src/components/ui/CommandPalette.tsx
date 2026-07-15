import { useEffect, useMemo, useState } from 'react'
import { Database, FileCode2, Search } from 'lucide-react'
import Modal from './Modal'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'

interface Props {
  open: boolean
  onClose: () => void
}

export default function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const { activeSessionId, sessions } = useSessionStore()
  const { tabs, activeTabId, openQueryTab, setActiveTab } = useTabStore()

  useEffect(() => { if (open) setQuery('') }, [open])

  const commands = useMemo(() => {
    const items: Array<{ id: string; label: string; detail: string; icon: typeof FileCode2; run: () => void }> = []
    if (activeSessionId) {
      const session = sessions.find(item => item.id === activeSessionId)
      items.push({
        id: 'new-query',
        label: 'New query tab',
        detail: session?.name ?? 'Active connection',
        icon: FileCode2,
        run: () => openQueryTab(activeSessionId),
      })
    }
    tabs.forEach(tab => items.push({
      id: `tab-${tab.id}`,
      label: `Switch to ${tab.label}`,
      detail: tab.type === 'table' ? `${tab.database}.${tab.table}` : tab.database ?? 'Query',
      icon: tab.type === 'table' ? Database : FileCode2,
      run: () => setActiveTab(tab.id),
    }))
    return items
  }, [activeSessionId, openQueryTab, sessions, setActiveTab, tabs])

  const visible = commands.filter(command =>
    `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()),
  )

  const run = (command: typeof commands[number]) => {
    command.run()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Command Palette" width="max-w-xl">
      <div className="space-y-3">
        <label className="flex items-center gap-2 rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-slate-400 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search commands and tabs"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
        </label>
        <div className="max-h-80 overflow-y-auto rounded-md border border-surface-700 p-1">
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-500">No matching commands</p>
          ) : visible.map(command => {
            const Icon = command.icon
            const active = command.id === `tab-${activeTabId}`
            return (
              <button
                key={command.id}
                type="button"
                onClick={() => run(command)}
                className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-brand-600/20 text-slate-100' : 'text-slate-300 hover:bg-surface-800'}`}
              >
                <Icon size={16} className="shrink-0 text-brand-400" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="max-w-[40%] truncate text-xs text-slate-500">{command.detail}</span>
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
