import { useState } from 'react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import type { ScriptQueryValidationResult } from '../../types'

interface BulkConfirmDialogProps {
  open: boolean
  validation: ScriptQueryValidationResult
  database?: string
  statements: string[]
  onConfirm: () => void
  onClose: () => void
}

function preview(statement: string): string {
  return statement.length > 160 ? statement.slice(0, 160) + '...' : statement
}

export default function BulkConfirmDialog({ open, validation, database, statements, onConfirm, onClose }: BulkConfirmDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false)

  const inserts = validation.operation_counts.INSERT ?? 0
  const updates = validation.operation_counts.UPDATE ?? 0
  const deletes = validation.operation_counts.DELETE ?? 0
  const hasDestructive = updates > 0 || deletes > 0

  const total = validation.statement_count
  const label = hasDestructive
    ? `Run ${total.toLocaleString()} writes (destructive)`
    : `Run ${total.toLocaleString()} inserts`
  const firstStatements = statements.slice(0, 2)
  const lastStatements = statements.length > 2 ? statements.slice(-2) : []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review bulk write"
      footer={
        <>
          <Button
            variant={hasDestructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={hasDestructive && !acknowledged}
          >
            {label}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <div className="bg-surface-800 rounded p-3 space-y-1">
          <div className="text-xs text-slate-500 uppercase tracking-wide font-medium">Operation mix</div>
          <div className="flex gap-4">
            {inserts > 0 && <span><span className="text-green-400 font-mono">{inserts.toLocaleString()}</span> INSERT</span>}
            {updates > 0 && <span><span className="text-amber-400 font-mono">{updates.toLocaleString()}</span> UPDATE</span>}
            {deletes > 0 && <span><span className="text-red-400 font-mono">{deletes.toLocaleString()}</span> DELETE</span>}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Total: {total.toLocaleString()} statements — one transaction, all-or-nothing.
          </div>
          <div className="text-xs text-slate-500">
            Database: <span className="text-slate-300 font-mono">{database || 'selected connection default'}</span>
          </div>
        </div>

        {statements.length > 0 && (
          <div className="bg-surface-800 rounded p-3 space-y-2">
            <div className="text-xs text-slate-500 uppercase tracking-wide font-medium">Statement preview</div>
            <div className="space-y-1">
              {firstStatements.map((statement, i) => (
                <pre key={`first-${i}`} className="max-h-20 overflow-auto rounded bg-surface-900 p-2 text-xs text-slate-400 whitespace-pre-wrap break-all">
                  {i + 1}. {preview(statement)}
                </pre>
              ))}
              {lastStatements.length > 0 && (
                <div className="text-xs text-slate-600">...</div>
              )}
              {lastStatements.map((statement, i) => {
                const index = statements.length - lastStatements.length + i + 1
                return (
                  <pre key={`last-${i}`} className="max-h-20 overflow-auto rounded bg-surface-900 p-2 text-xs text-slate-400 whitespace-pre-wrap break-all">
                    {index}. {preview(statement)}
                  </pre>
                )
              })}
            </div>
          </div>
        )}

        {hasDestructive && (
          <div className="bg-amber-950/40 border border-amber-800/50 rounded p-3 text-xs text-amber-300 space-y-2">
            <div className="font-medium">This will modify or delete data.</div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span>I understand this runs in one transaction and rolls back on first failure.</span>
            </label>
          </div>
        )}

        {!hasDestructive && (
          <div className="bg-surface-800 rounded p-3 text-xs text-slate-400">
            INSERT-only script. Runs in one transaction and rolls back on first failure.
          </div>
        )}
      </div>
    </Modal>
  )
}
