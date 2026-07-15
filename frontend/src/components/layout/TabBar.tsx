import { useState, useEffect, useRef } from 'react'
import { X, Terminal, Table, Plus, PanelLeftClose, Pencil } from 'lucide-react'
import clsx from 'clsx'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'
import type { Tab } from '../../types'
import ConfirmDialog from '../ui/ConfirmDialog'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'

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
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!activeTabId) return
    tabRefs.current[activeTabId]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [activeTabId, tabs.length])

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    if (contextMenu) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    tabButtonRefs.current[tabId]?.focus()
    setContextMenu({ tabId, x: e.clientX, y: e.clientY })
  }

  const closeContextMenu = () => setContextMenu(null)
  useMenuKeyboard(contextMenuRef, closeContextMenu, Boolean(contextMenu))

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    setActiveTab(nextTab.id)
    window.requestAnimationFrame(() => tabButtonRefs.current[nextTab.id]?.focus())
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
    const tab = tabs.find(item => item.id === tabId)
    setContextMenu(null)
    if (!tab?.dirty) {
      closeTab(tabId)
      return
    }
    setCloseTargetId(tabId)
  }

  const openRenameDialog = (tab: Tab) => {
    setContextMenu(null)
    setRenameTargetId(tab.id)
    setRenameValue(tab.label)
  }

  const saveRename = () => {
    const name = renameValue.trim()
    if (renameTargetId && name) renameTab(renameTargetId, name)
    setRenameTargetId(null)
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

  const hasDirtyTabs = tabs.some(tab => tab.dirty)
  const requestCloseAll = () => {
    if (hasDirtyTabs) setConfirmCloseAll(true)
    else closeAllTabs()
  }

  return (
    <div className="flex h-[46px] items-center bg-surface-900 border-b border-surface-800">
      <div className="flex-1 h-full overflow-hidden">
        <div role="tablist" aria-label="Open tabs" className="flex h-full items-center flex-nowrap overflow-x-scroll overflow-y-hidden space-x-1">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element
              }}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={handleDragEnd}
              onMouseDown={(e) => {
                if (e.button === 2) e.preventDefault()
              }}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              title={getTabTitle(tab)}
              className={clsx(
                'group flex h-[40px] select-none items-center gap-1.5 px-3 py-2 text-xs border-r border-surface-800 whitespace-nowrap transition-colors flex-shrink-0 cursor-move',
                activeTabId === tab.id
                  ? 'bg-surface-950 text-slate-100 border-t-2 border-t-brand-500'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800',
                draggedTabId === tab.id && 'opacity-50'
              )}
            >
              <button
                ref={element => { tabButtonRefs.current[tab.id] = element }}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={activeTabId === tab.id}
                aria-controls={`tab-panel-${tab.id}`}
                tabIndex={activeTabId === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
                title={getTabTitle(tab)}
                className="flex items-center gap-1.5"
              >
                {tab.type === 'query'
                  ? <Terminal size={12} className="flex-shrink-0" />
                  : <Table size={12} className="flex-shrink-0" />
                }
                {tab.dirty && <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
                {tab.type === 'table' && tab.database && (
                  <span className="max-w-[72px] truncate text-[10px] text-slate-500">{tab.database}</span>
                )}
                <span className="truncate max-w-[120px]">{tab.type === 'table' ? tab.table ?? tab.label : tab.label}</span>
              </button>
              <button
                type="button"
                onClick={() => requestCloseTab(tab.id)}
                title={getCloseTitle(tab)}
                aria-label={getCloseTitle(tab)}
                className="ml-0.5 rounded p-1 opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 group-hover:opacity-100"
              >
                <X size={10} />
              </button>
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
            onClick={requestCloseAll}
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
          ref={contextMenuRef}
          role="menu"
          aria-label="Tab actions"
          className="fixed z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-36"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {currentTab.type === 'query' && (
            <>
              <button
                role="menuitem"
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-700 transition-colors"
                onClick={() => openRenameDialog(currentTab)}
              >
                <Pencil size={12} />
                Rename
              </button>
              <div role="separator" className="my-1 border-t border-surface-700" />
            </>
          )}
          <button
            role="menuitem"
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
      <Modal
        open={renameTargetId !== null}
        onClose={() => setRenameTargetId(null)}
        title="Rename Tab"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRenameTargetId(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveRename} disabled={!renameValue.trim()}>Rename</Button>
          </>
        )}
      >
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Tab name
          <input
            value={renameValue}
            onChange={event => setRenameValue(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') saveRename() }}
            autoFocus
            className="rounded-md border border-surface-700 bg-surface-800 px-3 py-1.5 text-sm font-normal normal-case text-slate-100 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
          />
        </label>
      </Modal>
      <ConfirmDialog
        open={confirmCloseAll}
        title="Close All Tabs"
        message={hasDirtyTabs
          ? `Close all ${tabs.length} open tab${tabs.length === 1 ? '' : 's'}? Unsaved editor text or table changes will be discarded.`
          : `Close all ${tabs.length} open tab${tabs.length === 1 ? '' : 's'}?`}
        confirmLabel="Close All"
        danger
        onConfirm={handleConfirmCloseAll}
        onClose={() => setConfirmCloseAll(false)}
      />
    </div>
  )
}
