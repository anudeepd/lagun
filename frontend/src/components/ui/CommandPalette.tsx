import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  // Highlighted row. Reset to the top whenever the filtered list changes, so
  // `aria-activedescendant` always names a row that is on screen.
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessions = useSessionStore(s => s.sessions)
  const tabs = useTabStore(s => s.tabs)
  const activeTabId = useTabStore(s => s.activeTabId)
  const openQueryTab = useTabStore(s => s.openQueryTab)
  const setActiveTab = useTabStore(s => s.setActiveTab)

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

  const visible = useMemo(
    () => commands.filter(command => `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase())),
    [commands, query],
  )

  useEffect(() => { setActiveIndex(0) }, [visible])

  const activeCommand = visible[activeIndex]

  useEffect(() => {
    if (!open) return
    // `scrollIntoView` is absent in jsdom and in older browsers — optional call.
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open, visible])

  const run = (command: typeof commands[number]) => {
    command.run()
    onClose()
  }

  // Escape is left to Modal, which owns the dialog's close behaviour.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (visible.length === 0) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex(index => (index + 1) % visible.length)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex(index => (index - 1 + visible.length) % visible.length)
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(visible.length - 1)
        break
      case 'Enter':
        event.preventDefault()
        if (activeCommand) run(activeCommand)
        break
      default:
        break
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Command Palette" width="max-w-xl">
      <div className="space-y-3">
        <label className="flex items-center gap-2 rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-slate-400 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400">
          <Search size={16} />
          <input
            autoFocus
            role="combobox"
            aria-label="Search commands and tabs"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeCommand ? `${listboxId}-option-${activeCommand.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands and tabs"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-muted"
          />
        </label>
        <div id={listboxId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto rounded-md border border-surface-700 p-1">
          {visible.length === 0 ? (
            <p role="presentation" className="px-3 py-6 text-center text-sm text-muted">No matching commands</p>
          ) : visible.map((command, index) => {
            const Icon = command.icon
            const isCurrent = command.id === `tab-${activeTabId}`
            const isActive = index === activeIndex
            return (
              <button
                key={command.id}
                ref={node => { optionRefs.current[index] = node }}
                id={`${listboxId}-option-${command.id}`}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => run(command)}
                className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors ${isActive ? 'bg-surface-800 text-slate-100' : isCurrent ? 'bg-brand-600/20 text-slate-100' : 'text-slate-300 hover:bg-surface-800'}`}
              >
                <Icon size={16} className="shrink-0 text-brand-400" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="max-w-[40%] truncate text-xs text-muted">{command.detail}</span>
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
