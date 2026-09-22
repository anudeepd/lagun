import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import { api } from '../../api/client'
import Label from '../ui/Label'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table: string
  columns: string[]
  currentPkColumns: string[]
}

export default function PrimaryKeyDialog({
  open,
  onClose,
  sessionId,
  database,
  table,
  columns,
  currentPkColumns,
}: Props) {
  // Callers keep this dialog mounted so Modal can play its exit animation, so a
  // fresh open no longer remounts and re-runs the initialiser — and at first
  // mount `currentPkColumns` is still `[]` (the indexes have not loaded yet), so
  // an existing primary key was never shown. Reset on open instead; the reset
  // lands while the dialog is still fully transparent.
  const [selectedCols, setSelectedCols] = useState<string[]>(currentPkColumns)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentPkKey = currentPkColumns.join('\u0000')

  useEffect(() => {
    if (!open) return
    // `currentPkColumns` is a fresh array on most parent renders (the caller
    // falls back to `?? []`), so key the reset on its contents instead.
    setSelectedCols(currentPkKey === '' ? [] : currentPkKey.split('\u0000'))
    setError(null)
  }, [open, currentPkKey])

  const toggleCol = (col: string) => {
    setSelectedCols(prev =>
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    )
  }

  const handleSave = async () => {
    if (selectedCols.length === 0) {
      setError('Select at least one column')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.setPrimaryKey(sessionId, database, table, selectedCols)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDrop = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.dropPrimaryKey(sessionId, database, table)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Manage Primary Key — ${table}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {currentPkColumns.length > 0 && (
            <Button variant="ghost" onClick={handleDrop} disabled={saving} className="text-red-400 hover:text-red-300">
              Drop PK
            </Button>
          )}
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-xs text-red-400">{error}</p>}

        <div>
          <Label as="span">Columns</Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {columns.map(col => (
              <button
                key={col}
                onClick={() => toggleCol(col)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  selectedCols.includes(col)
                    ? 'bg-brand-600 border-brand-500 text-white'
                    : 'bg-surface-800 border-surface-700 text-slate-300 hover:border-brand-500'
                }`}
              >
                {col}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
