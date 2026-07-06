import { useState, useEffect } from 'react'
import { X, Terminal, Table, Plus, PanelLeftClose, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'
import type { Tab } from '../../types'
import ConfirmDialog from '../ui/ConfirmDialog'

interface ContextMenuState {
  tabId: string
  x: number
  y: number
}

export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openQueryTab, closeAllTabs, moveTab, renameTab } = useTabStore()
  const { activeSessionId } = useSessionStore()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    if (contextMenu) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [contextMenu])

  // Close on escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [setContextMenu])

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    setContextMenu({ tabId, x: e.clientX, y: e.clientY })
  }

  const handleDragStart = (e: React.DragEvent, tabId: string) => {
    setDraggedTabId(tabId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (e: React.DragEvent, targetTabId: string) => {
    e.preventDefault()
    if (draggedTabId && draggedTabId !== targetTabId) {
      moveTab(draggedTabId, targetTabId)
    }
    setDraggedTabId(null)
  }

  const handleDragEnd = () => {
    setDraggedTabId(null)
  }

  const currentTab = contextMenu ? tabs.find(t => t.id === contextMenu.tabId) : null
  const closeTarget = closeTargetId ? tabs.find(t => t.id === closeTargetId) : null

  const getTabTitle = (tab: Tab) => {
    if (tab.type === 'query') {
      return tab.database ? `Query tab for ${tab.database}` : 'Query tab'
    }
    return tab.database ? `Table tab for ${tab.database}.${tab.table ?? tab.label}` : `Table tab for ${tab.label}`
  }

  const getCloseTitle = (tab: Tab) => `Close ${getTabTitle(tab).toLowerCase()}`

  const requestCloseTab = (tabId: string) => {
    setContextMenu(null)
    setCloseTargetId(tabId)
  }

  const handleConfirmCloseTab = () => {
    if (!closeTargetId) return
    closeTab(closeTargetId)
    setCloseTargetId(null)
  }

  const handleConfirmCloseAll = () => {
    closeAllTabs()
    setConfirmCloseAll(false)
  }

  return (
    <div className="flex h-[46px] items-center bg-surface-900 border-b border-surface-800">
      <div className="flex-1 h-full overflow-hidden">
        <div className="flex h-full items-center flex-nowrap overflow-x-scroll overflow-y-hidden space-x-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={handleDragEnd}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              title={getTabTitle(tab)}
              className={clsx(
                'group flex h-[40px] items-center gap-1.5 px-3 py-2 text-xs border-r border-surface-800 whitespace-nowrap transition-colors flex-shrink-0 cursor-move',
                activeTabId === tab.id
                  ? 'bg-surface-950 text-slate-100 border-t-2 border-t-brand-500'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800',
                draggedTabId === tab.id && 'opacity-50'
              )}
            >
              <button
                onClick={() => setActiveTab(tab.id)}
                title={getTabTitle(tab)}
                className="flex items-center gap-1.5"
              >
                {tab.type === 'query'
                  ? <Terminal size={12} className="flex-shrink-0" />
                  : <Table size={12} className="flex-shrink-0" />
                }
                {tab.type === 'table' && tab.database && (
                  <span className="max-w-[72px] truncate text-[10px] text-slate-500">{tab.database}</span>
                )}
                <span className="truncate max-w-[120px]">{tab.type === 'table' ? tab.table ?? tab.label : tab.label}</span>
              </button>
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); requestCloseTab(tab.id) }}
                title={getCloseTitle(tab)}
                className="ml-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
              >
                <X size={10} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex h-[40px] items-center">
        {activeSessionId && (
          <button
            onClick={() => openQueryTab(activeSessionId)}
            title="New query tab"
            className="flex h-full items-center gap-1 px-3 text-xs text-slate-500 hover:text-slate-200 hover:bg-surface-800 transition-colors whitespace-nowrap border-l border-surface-800"
          >
            <Plus size={12} />
            <span className="hidden sm:inline">New Query</span>
          </button>
        )}
        {tabs.length > 0 && (
          <button
            onClick={() => setConfirmCloseAll(true)}
            title="Close all tabs"
            className="flex h-full items-center gap-1 px-3 text-xs text-slate-500 hover:text-red-400 hover:bg-surface-800 transition-colors whitespace-nowrap border-l border-surface-800"
          >
            <PanelLeftClose size={12} />
            <span className="hidden sm:inline">Close All</span>
          </button>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && currentTab && (
        <div
          className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-36"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {currentTab.type === 'query' && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
              onClick={() => {
                setContextMenu(null)
                const newLabel = prompt('Rename tab:', currentTab.label)
                if (newLabel !== null && newLabel.trim() !== '') {
                  renameTab(currentTab.id, newLabel.trim())
                }
              }}
            >
              <Pencil size={12} />
              Rename
            </button>
          )}
          <div className="my-1 border-t border-surface-700" />
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-surface-700 transition-colors"
            onClick={() => requestCloseTab(currentTab.id)}
          >
            <X size={12} />
            Close
          </button>
        </div>
      )}
      <ConfirmDialog
        open={!!closeTarget}
        title="Close Tab"
        message={`Close "${closeTarget?.label ?? ''}"? Unsaved editor text or table changes in this tab will be discarded.`}
        confirmLabel="Close"
        danger
        onConfirm={handleConfirmCloseTab}
        onClose={() => setCloseTargetId(null)}
      />
      <ConfirmDialog
        open={confirmCloseAll}
        title="Close All Tabs"
        message={`Close all ${tabs.length} open tab${tabs.length === 1 ? '' : 's'}? Unsaved editor text or table changes will be discarded.`}
        confirmLabel="Close All"
        danger
        onConfirm={handleConfirmCloseAll}
        onClose={() => setConfirmCloseAll(false)}
      />
    </div>
  )
}
