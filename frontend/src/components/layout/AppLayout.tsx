import Sidebar from './Sidebar'
import TabBar from './TabBar'
import TabContent from '../editor/TabContent'
import QueryLogPanel from './QueryLogPanel'
import { useTabStore } from '../../store/tabStore'
import Logo from '../ui/Logo'

export default function AppLayout() {
  const { tabs, activeTabId } = useTabStore()

  return (
    <div className="flex h-screen overflow-hidden bg-surface-950 text-slate-100">
      {/* Left sidebar */}
      <Sidebar />

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
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
