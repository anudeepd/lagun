import { useState } from 'react'
import { Plus, Upload, Download } from 'lucide-react'
import { useSessionStore } from '../../store/sessionStore'
import SessionList from '../sessions/SessionList'
import SessionForm from '../sessions/SessionForm'
import ConfigExportDialog from '../sessions/ConfigExportDialog'
import ConfigImportDialog from '../sessions/ConfigImportDialog'
import SchemaTree from '../schema/SchemaTree'
import Button from '../ui/Button'
import Logo from '../ui/Logo'

export default function Sidebar() {
  const { sessions, activeSessionId } = useSessionStore()
  const [showForm, setShowForm] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showImport, setShowImport] = useState(false)

  return (
    <aside className="w-64 flex-shrink-0 bg-surface-900 border-r border-surface-800 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-surface-800">
        <Logo size="sm" showText={true} />
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImport(true)}
            title="Import connections"
            className="p-1"
          >
            <Upload size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowExport(true)}
            title="Export connections"
            className="p-1"
          >
            <Download size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowForm(true)}
            title="New connection"
            className="p-1"
          >
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-shrink-0 border-b border-surface-800">
        <SessionList onNew={() => setShowForm(true)} />
      </div>

      {/* Schema tree for active session */}
      <div className="flex-1 overflow-y-auto">
        {activeSessionId && (() => {
          const activeSession = sessions.find(s => s.id === activeSessionId)
          return (
            <SchemaTree
              sessionId={activeSessionId}
              selectedDatabases={activeSession?.selected_databases}
            />
          )
        })()}
      </div>

      {/* Modals */}
      <SessionForm open={showForm} onClose={() => setShowForm(false)} />
      <ConfigExportDialog open={showExport} onClose={() => setShowExport(false)} />
      <ConfigImportDialog open={showImport} onClose={() => setShowImport(false)} />
    </aside>
  )
}
