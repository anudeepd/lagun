import { X, Terminal, Table, Plus, PanelLeftClose } from 'lucide-react'
import clsx from 'clsx'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'

export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openQueryTab, closeAllTabs } = useTabStore()
  const { activeSessionId } = useSessionStore()

  return (
    <div className="flex items-center bg-surface-900 border-b border-surface-800 overflow-x-auto flex-shrink-0">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-2 text-xs border-r border-surface-800 whitespace-nowrap min-w-0 group transition-colors',
            activeTabId === tab.id
              ? 'bg-surface-950 text-slate-100 border-t-2 border-t-brand-500'
              : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800'
          )}
        >
          {tab.type === 'query'
            ? <Terminal size={12} className="flex-shrink-0" />
            : <Table size={12} className="flex-shrink-0" />
          }
          <span className="truncate max-w-[120px]">{tab.label}</span>
          <span
            role="button"
            onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
            className="ml-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
          >
            <X size={10} />
          </span>
        </button>
      ))}
      {activeSessionId && (
        <button
          onClick={() => openQueryTab(activeSessionId)}
          title="New query tab"
          className="flex items-center gap-1 px-3 py-2 text-xs text-slate-500 hover:text-slate-200 hover:bg-surface-800 transition-colors whitespace-nowrap flex-shrink-0 border-r border-surface-800"
        >
          <Plus size={12} />
          New Query
        </button>
      )}
      {tabs.length > 0 && (
        <button
          onClick={closeAllTabs}
          title="Close all tabs"
          className="flex items-center gap-1 px-3 py-2 text-xs text-slate-500 hover:text-red-400 hover:bg-surface-800 transition-colors whitespace-nowrap flex-shrink-0 ml-auto"
        >
          <PanelLeftClose size={12} />
          Close All
        </button>
      )}
    </div>
  )
}
