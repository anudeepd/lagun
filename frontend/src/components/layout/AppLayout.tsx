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

const MIN_SIDEBAR = 160
const MAX_SIDEBAR = 520

export default function AppLayout() {
  const { tabs, activeTabId } = useTabStore()
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('lagun-sidebar-width')
    return saved ? Number(saved) : 256
  })
  const startRef = useRef<{ x: number; width: number } | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)

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
      {mobileSidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      {/* Left sidebar */}
      <div style={{ width: sidebarWidth }} className={`fixed inset-y-0 left-0 z-40 flex min-h-0 max-w-[85vw] border-r border-surface-800 transition-transform duration-200 lg:relative lg:inset-auto lg:max-w-[45vw] lg:translate-x-0 ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar />
        <div
          onMouseDown={handleResizeMouseDown}
          title="Resize sidebar"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          className="group absolute inset-y-0 right-0 z-10 hidden w-2 translate-x-1/2 cursor-col-resize lg:block"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-brand-500" />
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex min-h-[46px] items-center border-b border-surface-800 lg:hidden">
          <button type="button" onClick={() => setMobileSidebarOpen(true)} aria-label="Open navigation" className="lagun-icon-button m-1 rounded p-2 text-slate-300 hover:bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Menu size={18} />
          </button>
          <span className="text-sm font-medium text-slate-300">Lagun</span>
          <button type="button" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette" className="lagun-icon-button ml-auto mr-2 rounded p-2 text-slate-400 hover:bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Command size={18} />
          </button>
        </div>
        <TabBar />
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-hidden min-h-0 focus:outline-none">
          {tabs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
              <Logo size="lg" showText={false} className="opacity-40" />
              <p className="text-sm">Select a table from the sidebar or open a query tab</p>
            </div>
          ) : (
            tabs.map(tab => (
              <div
                key={tab.id}
                id={`tab-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`tab-${tab.id}`}
                className={`h-full min-h-0 ${activeTabId === tab.id ? '' : 'hidden'}`}
              >
                <TabContent tab={tab} />
              </div>
            ))
          )}
        </main>
        <QueryLogPanel />
      </div>
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
    </div>
  )
}
