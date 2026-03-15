import { useState } from 'react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import { api } from '../../api/client'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table: string
  columns: string[]
}

export default function IndexDialog({ open, onClose, sessionId, database, table, columns }: Props) {
  const [name, setName] = useState('')
  const [selectedCols, setSelectedCols] = useState<string[]>([])
  const [unique, setUnique] = useState(false)
  const [indexType, setIndexType] = useState('BTREE')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleCol = (col: string) => {
    setSelectedCols(prev =>
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    )
  }

  const handleCreate = async () => {
    if (!name || selectedCols.length === 0) {
      setError('Name and at least one column are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.createIndex(sessionId, database, table, {
        name,
        columns: selectedCols,
        is_unique: unique,
        index_type: indexType,
      } as any)
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
      title={`Create Index on ${table}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleCreate} disabled={saving}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-xs text-red-400">{error}</p>}
        <Input label="Index Name" value={name} onChange={e => setName(e.target.value)} placeholder="idx_column" />

        <div>
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Columns</label>
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

        <Select label="Index Type" value={indexType} onChange={e => setIndexType(e.target.value)}>
          <option value="BTREE">BTREE</option>
          <option value="HASH">HASH</option>
          <option value="FULLTEXT">FULLTEXT</option>
        </Select>

        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={unique} onChange={e => setUnique(e.target.checked)} />
          Unique
        </label>
      </div>
    </Modal>
  )
}
