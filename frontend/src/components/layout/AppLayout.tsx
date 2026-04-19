import { useRef, useState } from 'react'
import Sidebar from './Sidebar'
import TabBar from './TabBar'
import TabContent from '../editor/TabContent'
import QueryLogPanel from './QueryLogPanel'
import { useTabStore } from '../../store/tabStore'
import Logo from '../ui/Logo'

const MIN_SIDEBAR = 160
const MAX_SIDEBAR = 520

export default function AppLayout() {
  const { tabs, activeTabId } = useTabStore()
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('lagun-sidebar-width')
    return saved ? Number(saved) : 256
  })
  const startRef = useRef<{ x: number; width: number } | null>(null)

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
    <div className="flex h-screen overflow-hidden bg-surface-950 text-slate-100">
      {/* Left sidebar */}
      <div style={{ width: sidebarWidth }} className="flex-shrink-0 flex">
        <Sidebar />
        <div
          onMouseDown={handleResizeMouseDown}
          className="w-1 flex-shrink-0 bg-surface-800 hover:bg-brand-500 cursor-col-resize transition-colors"
        />
      </div>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        <TabBar />
        <div className="flex-1 overflow-hidden">
          {tabs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
              <Logo size="lg" showText={false} className="opacity-40" />
              <p className="text-sm">Select a table from the sidebar or open a query tab</p>
            </div>
          ) : (
            tabs.map(tab => (
              <div
                key={tab.id}
                className={`h-full ${activeTabId === tab.id ? '' : 'hidden'}`}
              >
                <TabContent tab={tab} />
              </div>
            ))
          )}
        </div>
        <QueryLogPanel />
      </div>
    </div>
  )
}
