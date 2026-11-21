import { useState } from 'react'
import { Plus, Upload, Download, LogOut } from 'lucide-react'
import { useSessionStore } from '../../store/sessionStore'
import { useServerConfigStore } from '../../store/serverConfigStore'
import SessionList from '../sessions/SessionList'
import SessionForm from '../sessions/SessionForm'
import ConfigExportDialog from '../sessions/ConfigExportDialog'
import ConfigImportDialog from '../sessions/ConfigImportDialog'
import SchemaTree from '../schema/SchemaTree'
import Button from '../ui/Button'
import Logo from '../ui/Logo'
import Tooltip from '../ui/Tooltip'
import { submitLdapLogout } from '../../utils/authRedirect'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, spatialTransition } from '../../motion/tokens'

export default function Sidebar() {
  const { sessions, activeSessionId } = useSessionStore()
  const ldapEnabled = useServerConfigStore(s => s.ldapEnabled)
  const [showForm, setShowForm] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const submitLogout = () => {
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = '/_auth/logout'
    document.body.appendChild(form)
    submitLdapLogout(form)
  }

  return (
    <aside className="w-full bg-surface-900 flex flex-col overflow-hidden select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-surface-800">
        <Logo size="sm" showText={true} />
        <div className="flex items-center gap-0.5">
          <Tooltip side="bottom" label="Import connections">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowImport(true)}
              aria-label="Import connections"
              className="lagun-icon-button p-1"
            >
              <Upload size={14} />
            </Button>
          </Tooltip>
          <Tooltip side="bottom" label="Export connections">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowExport(true)}
              aria-label="Export connections"
              className="lagun-icon-button p-1"
            >
              <Download size={14} />
            </Button>
          </Tooltip>
          <Tooltip side="bottom" label="New connection">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowForm(true)}
              aria-label="New connection"
              className="lagun-icon-button p-1"
            >
              <Plus size={14} />
            </Button>
          </Tooltip>
          {ldapEnabled && (
            <Tooltip side="bottom" label="Logout">
              <Button
                variant="ghost"
                size="sm"
                onClick={submitLogout}
                aria-label="Logout"
                className="lagun-icon-button p-1"
              >
                <LogOut size={14} />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-shrink-0 border-b border-surface-800">
        <SessionList />
      </div>

      {/* Schema tree for active session */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <AnimatePresence initial={false} mode="sync">
        {activeSessionId && (() => {
          const activeSession = sessions.find(s => s.id === activeSessionId)
          return (
            <m.div
              key={activeSessionId}
              initial={{ opacity: 0, x: motionDistance.surface }}
              animate={{ opacity: 1, x: 0, transition: spatialTransition }}
              exit={{ opacity: 0, x: -motionDistance.surface, transition: exitTransition }}
              className="absolute inset-0"
            >
              <SchemaTree
                sessionId={activeSessionId}
                selectedDatabases={activeSession?.selected_databases}
              />
            </m.div>
          )
        })()}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <SessionForm open={showForm} onClose={() => setShowForm(false)} />
      <ConfigExportDialog open={showExport} onClose={() => setShowExport(false)} />
      <ConfigImportDialog open={showImport} onClose={() => setShowImport(false)} />
    </aside>
  )
}
