import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import { api } from '../../api/client'

interface ColDef {
  name: string
  type: string
  nullable: boolean
  primary_key: boolean
  auto_increment: boolean
  default?: string
}

const defaultCol = (): ColDef => ({
  name: '',
  type: 'VARCHAR(255)',
  nullable: true,
  primary_key: false,
  auto_increment: false,
})

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  onCreated: () => void
}

const COMMON_TYPES = [
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'VARCHAR(255)', 'TEXT', 'LONGTEXT',
  'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
  'DATETIME', 'DATE', 'TIMESTAMP',
  'BOOLEAN', 'JSON', 'BLOB',
]

export default function CreateTableDialog({ open, onClose, sessionId, database, onCreated }: Props) {
  const [tableName, setTableName] = useState('')
  const [cols, setCols] = useState<ColDef[]>([
    { name: 'id', type: 'INT', nullable: false, primary_key: true, auto_increment: true }
  ])
  const [engine, setEngine] = useState('InnoDB')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateCol = (i: number, patch: Partial<ColDef>) =>
    setCols(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  const removeCol = (i: number) =>
    setCols(prev => prev.filter((_, idx) => idx !== i))

  const handleCreate = async () => {
    if (!tableName) { setError('Table name required'); return }
    if (cols.some(c => !c.name)) { setError('All columns need a name'); return }
    setSaving(true)
    setError(null)
    try {
      await api.createTable(sessionId, database, {
        name: tableName,
        columns: cols,
        engine,
        charset: 'utf8mb4',
        collation: 'utf8mb4_unicode_ci',
      } as any)
      onCreated()
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
      title={`Create Table in ${database}`}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleCreate} disabled={saving}>
            Create Table
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="grid grid-cols-2 gap-3">
          <Input label="Table Name" value={tableName} onChange={e => setTableName(e.target.value)} placeholder="my_table" />
          <Select label="Engine" value={engine} onChange={e => setEngine(e.target.value)}>
            <option>InnoDB</option>
            <option>MyISAM</option>
            <option>MEMORY</option>
          </Select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Columns</label>
            <Button variant="ghost" size="sm" onClick={() => setCols(prev => [...prev, defaultCol()])}>
              <Plus size={12} /> Add Column
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-12 gap-1 text-xs text-slate-500 px-1 mb-1">
              <span className="col-span-3">Name</span>
              <span className="col-span-4">Type</span>
              <span className="col-span-1 text-center">NULL</span>
              <span className="col-span-1 text-center">PK</span>
              <span className="col-span-1 text-center">AI</span>
              <span className="col-span-2" />
            </div>
            {cols.map((col, i) => (
              <div key={i} className="grid grid-cols-12 gap-1 items-center">
                <input
                  className="col-span-3 bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  value={col.name}
                  onChange={e => updateCol(i, { name: e.target.value })}
                  placeholder="column_name"
                />
                <select
                  className="col-span-4 bg-surface-800 border border-surface-700 rounded px-1 py-1 text-xs text-slate-100 focus:outline-none"
                  value={col.type}
                  onChange={e => updateCol(i, { type: e.target.value })}
                >
                  {COMMON_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
                <div className="col-span-1 flex justify-center">
                  <input type="checkbox" checked={col.nullable} onChange={e => updateCol(i, { nullable: e.target.checked })} />
                </div>
                <div className="col-span-1 flex justify-center">
                  <input type="checkbox" checked={col.primary_key} onChange={e => updateCol(i, { primary_key: e.target.checked })} />
                </div>
                <div className="col-span-1 flex justify-center">
                  <input type="checkbox" checked={col.auto_increment} onChange={e => updateCol(i, { auto_increment: e.target.checked })} />
                </div>
                <div className="col-span-2 flex justify-end">
                  <button onClick={() => removeCol(i)} className="p-0.5 text-slate-600 hover:text-red-400">
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
