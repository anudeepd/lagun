import { useEffect, useRef, useState } from 'react'
import { Command, Menu } from 'lucide-react'
import Sidebar from './Sidebar'
import TabBar from './TabBar'
import TabContent from '../editor/TabContent'
import QueryLogPanel from './QueryLogPanel'
import { useTabStore } from '../../store/tabStore'
import Logo from '../ui/Logo'
import CommandPalette from '../ui/CommandPalette'
import ShortcutHelpDialog from '../ui/ShortcutHelpDialog'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, surfaceTransition } from '../../motion/tokens'

const MIN_SIDEBAR = 160
const MAX_SIDEBAR = 520

export default function AppLayout({ navigateToAdmin }: { navigateToAdmin?: () => void } = {}) {
  const tabs = useTabStore(s => s.tabs)
  const activeTabId = useTabStore(s => s.activeTabId)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('lagun-sidebar-width')
    return saved ? Number(saved) : 256
  })
  const startRef = useRef<{ x: number; width: number } | null>(null)
  const mobileOpenButtonRef = useRef<HTMLButtonElement>(null)
  const mobileSidebarRef = useRef<HTMLDivElement>(null)
  const mainAreaRef = useRef<HTMLDivElement>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)

  useEffect(() => {
    if (!mobileSidebarOpen) return
    const sidebar = mobileSidebarRef.current
    const mainArea = mainAreaRef.current
    if (mainArea) (mainArea as HTMLDivElement & { inert: boolean }).inert = true
    const getFocusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
    getFocusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileSidebarOpen(false)
        window.requestAnimationFrame(() => mobileOpenButtonRef.current?.focus())
      } else if (event.key === 'Tab') {
        const focusable = getFocusable()
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      if (mainArea) (mainArea as HTMLDivElement & { inert: boolean }).inert = false
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileSidebarOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen(open => !open)
      }
      if (event.key === '?' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable))) {
        event.preventDefault()
        setShortcutHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const resizeSidebarBy = (delta: number) => {
    setSidebarWidth(previous => {
      const next = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, previous + delta))
      localStorage.setItem('lagun-sidebar-width', String(next))
      return next
    })
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      resizeSidebarBy(event.key === 'ArrowRight' ? 16 : -16)
    } else if (event.key === 'Home') {
      event.preventDefault()
      resizeSidebarBy(MIN_SIDEBAR - sidebarWidth)
    } else if (event.key === 'End') {
      event.preventDefault()
      resizeSidebarBy(MAX_SIDEBAR - sidebarWidth)
    }
  }
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    startRef.current = { x: e.clientX, width: sidebarWidth }
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return
      const next = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, startRef.current.width + e.clientX - startRef.current.x))
      setSidebarWidth(next)
      localStorage.setItem('lagun-sidebar-width', String(next))
    }
    const onUp = () => {
      startRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-surface-950 text-slate-100">
      <AnimatePresence>
        {mobileSidebarOpen && (
          <m.button
            type="button"
            aria-label="Close navigation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: surfaceTransition }}
            exit={{ opacity: 0, transition: exitTransition }}
            className="fixed inset-0 z-navigation bg-black/60 lg:hidden"
            onClick={() => { setMobileSidebarOpen(false); window.requestAnimationFrame(() => mobileOpenButtonRef.current?.focus()) }}
          />
        )}
      </AnimatePresence>
      <div ref={mobileSidebarRef} style={{ width: sidebarWidth }} className={`fixed inset-y-0 left-0 z-navigation flex min-h-0 max-w-[85vw] border-r border-surface-800 transition-transform [transition-duration:var(--motion-duration-spatial)] lg:relative lg:inset-auto lg:max-w-[45vw] lg:translate-x-0 ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar />
        <div
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
          title="Resize sidebar"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR}
          aria-valuemax={MAX_SIDEBAR}
          tabIndex={0}
          className="group absolute inset-y-0 right-0 z-10 hidden w-2 translate-x-1/2 cursor-col-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 lg:block"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-brand-700" />
        </div>
      </div>

      <div ref={mainAreaRef} className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex min-h-[46px] items-center border-b border-surface-800 lg:hidden">
          <button ref={mobileOpenButtonRef} type="button" onClick={() => setMobileSidebarOpen(true)} aria-label="Open navigation" className="lagun-icon-button m-1 rounded p-2 text-slate-300 hover:bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <Menu size={18} />
          </button>
          <span className="text-sm font-medium text-slate-300">Lagun</span>
          <button type="button" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette" className="lagun-icon-button ml-auto mr-2 rounded p-2 text-slate-400 hover:bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <Command size={18} />
          </button>
        </div>
        <TabBar onOpenAdmin={navigateToAdmin} />
        <main id="main-content" tabIndex={-1} className="relative flex-1 overflow-hidden min-h-0 focus:outline-none">
          {tabs.length === 0 ? (
            <m.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: surfaceTransition }} className="flex h-full flex-col items-center justify-center gap-4 text-muted">
              <Logo size="lg" showText={false} className="opacity-40" />
              <p className="text-sm">Select a table from the sidebar or open a query tab</p>
            </m.div>
          ) : (
            tabs.map(tab => {
              const active = activeTabId === tab.id
              return (
                <div
                  key={tab.id}
                  id={`tab-panel-${tab.id}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${tab.id}`}
                  aria-hidden={!active || undefined}
                  className={`h-full min-h-0 ${active ? 'relative' : 'pointer-events-none absolute inset-0 invisible'}`}
                  ref={node => {
                    if (node) (node as HTMLDivElement & { inert: boolean }).inert = !active
                  }}
                >
                  <TabContent tab={tab} active={active} />
                </div>
              )
            })
          )}
        </main>
        <QueryLogPanel />
      </div>
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
    </div>
  )
}
