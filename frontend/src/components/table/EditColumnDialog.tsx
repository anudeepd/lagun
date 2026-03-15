import { useState, useEffect } from 'react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import { api } from '../../api/client'
import type { ColumnInfo } from '../../types'

const COMMON_TYPES = [
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
  'VARCHAR(255)', 'VARCHAR(100)', 'VARCHAR(50)',
  'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'CHAR(1)', 'CHAR(36)',
  'DATE', 'DATETIME', 'TIMESTAMP',
  'BOOLEAN', 'JSON',
  '__custom__',
]

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table: string
  mode: 'add' | 'modify'
  column?: ColumnInfo
  onSaved: () => void
}

export default function EditColumnDialog({
  open, onClose, sessionId, database, table, mode, column, onSaved,
}: Props) {
  const [name, setName] = useState('')
  const [typeSelect, setTypeSelect] = useState('VARCHAR(255)')
  const [customType, setCustomType] = useState('')
  const [nullable, setNullable] = useState(true)
  const [defaultVal, setDefaultVal] = useState('')
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (mode === 'modify' && column) {
      setName(column.name)
      const knownType = COMMON_TYPES.includes(column.column_type) ? column.column_type : '__custom__'
      setTypeSelect(knownType)
      setCustomType(knownType === '__custom__' ? column.column_type : '')
      setNullable(column.is_nullable)
      setDefaultVal(column.column_default ?? '')
      setComment(column.comment ?? '')
    } else {
      setName('')
      setTypeSelect('VARCHAR(255)')
      setCustomType('')
      setNullable(true)
      setDefaultVal('')
      setComment('')
    }
    setError(null)
  }, [open, mode, column])

  const effectiveType = typeSelect === '__custom__' ? customType : typeSelect

  const handleSave = async () => {
    if (!name.trim()) { setError('Column name is required.'); return }
    if (!effectiveType.trim()) { setError('Column type is required.'); return }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        name: name.trim(),
        type: effectiveType.trim(),
        nullable,
        default: defaultVal || null,
        comment: comment || undefined,
      }
      if (mode === 'add') {
        await api.addColumn(sessionId, database, table, payload)
      } else {
        await api.modifyColumn(sessionId, database, table, column!.name, payload)
      }
      onSaved()
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
      title={mode === 'add' ? `Add Column to ${table}` : `Edit Column: ${column?.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {mode === 'add' ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-xs text-red-400">{error}</p>}

        <Input
          label="Name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="column_name"
        />

        <Select
          label="Type"
          value={typeSelect}
          onChange={e => setTypeSelect(e.target.value)}
        >
          {COMMON_TYPES.filter(t => t !== '__custom__').map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </Select>

        {typeSelect === '__custom__' && (
          <Input
            label="Custom Type"
            value={customType}
            onChange={e => setCustomType(e.target.value)}
            placeholder="e.g. ENUM('a','b')"
          />
        )}

        <Input
          label="Default Value"
          value={defaultVal}
          onChange={e => setDefaultVal(e.target.value)}
          placeholder="(none)"
        />

        <Input
          label="Comment"
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder=""
        />

        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={nullable} onChange={e => setNullable(e.target.checked)} />
          Nullable
        </label>
      </div>
    </Modal>
  )
}
