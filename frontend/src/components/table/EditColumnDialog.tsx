import { useState, useEffect } from 'react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import { api } from '../../api/client'
import { showToast } from '../../utils/toast'
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

const DEFAULT_FUNCTION_MODES = [
  'CURRENT_TIMESTAMP',
  'CURRENT_TIMESTAMP(3)',
  'CURRENT_TIMESTAMP(6)',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'UUID()',
  'RAND()',
] as const

type DefaultExpression = typeof DEFAULT_FUNCTION_MODES[number]
type DefaultMode = 'none' | 'null' | 'literal' | DefaultExpression

const DEFAULT_MODE_OPTIONS: Array<{ value: DefaultMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'null', label: 'NULL' },
  { value: 'literal', label: 'Literal' },
  ...DEFAULT_FUNCTION_MODES.map(value => ({ value, label: value })),
]

function parseDefaultValue(value: string | null): { mode: DefaultMode; literal: string } {
  if (value == null) return { mode: 'none', literal: '' }
  const unwrapped = value.trim().replace(/^\((.*)\)$/, '$1').toUpperCase()
  const canonical = unwrapped.replace(
    /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP)\(\)$/,
    '$1',
  )
  const normalized: string = {
    'CURDATE()': 'CURRENT_DATE',
    'CURTIME()': 'CURRENT_TIME',
    'LOCALTIMESTAMP': 'CURRENT_TIMESTAMP',
  }[canonical] ?? canonical
  if ((DEFAULT_FUNCTION_MODES as readonly string[]).includes(normalized)) {
    return { mode: normalized as DefaultExpression, literal: '' }
  }
  return { mode: 'literal', literal: value }
}

const NUMERIC_TYPES: Record<string, true> = {
  TINYINT: true, SMALLINT: true, MEDIUMINT: true, INT: true, INTEGER: true, BIGINT: true,
  DECIMAL: true, NUMERIC: true, FLOAT: true, DOUBLE: true, REAL: true, BIT: true,
}

function columnTypeParts(type: string): { base: string; precision: string | null } {
  const match = type.trim().toUpperCase().match(/^([A-Z]+)(?:\((\d+)(?:,\s*\d+)?\))?/)
  return { base: match?.[1] ?? '', precision: match?.[2] ?? null }
}

function defaultModeError(mode: DefaultMode, type: string, nullable: boolean): string | null {
  if (mode === 'none' || mode === 'literal') return null
  if (mode === 'null') return nullable ? null : 'NULL default requires Nullable.'

  const { base, precision } = columnTypeParts(type)
  if (mode.startsWith('CURRENT_TIMESTAMP')) {
    const expressionPrecision = mode.match(/\((\d+)\)$/)?.[1] ?? '0'
    return (base === 'TIMESTAMP' || base === 'DATETIME') && precision === expressionPrecision
      ? null
      : 'CURRENT_TIMESTAMP defaults require TIMESTAMP or DATETIME with matching precision.'
  }
  if (mode === 'CURRENT_DATE') return base === 'DATE' ? null : 'CURRENT_DATE default requires DATE.'
  if (mode === 'CURRENT_TIME') return base === 'TIME' ? null : 'CURRENT_TIME default requires TIME.'
  if (mode === 'UUID()') {
    return base === 'CHAR' || base === 'VARCHAR' || base === 'UUID'
      ? null
      : 'UUID() default requires CHAR, VARCHAR, or UUID.'
  }
  if (mode === 'RAND()') return NUMERIC_TYPES[base] ? null : 'RAND() default requires a numeric column.'
  return 'Unsupported default expression.'
}

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table: string
  mode: 'add' | 'modify'
  column?: ColumnInfo
  onSaved: () => void | Promise<void>
}

export default function EditColumnDialog({
  open, onClose, sessionId, database, table, mode, column, onSaved,
}: Props) {
  const [name, setName] = useState('')
  const [typeSelect, setTypeSelect] = useState('VARCHAR(255)')
  const [customType, setCustomType] = useState('')
  const [nullable, setNullable] = useState(true)
  const [defaultVal, setDefaultVal] = useState('')
  const [defaultMode, setDefaultMode] = useState<DefaultMode>('none')
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
      const parsedDefault = parseDefaultValue(column.column_default)
      setDefaultMode(parsedDefault.mode)
      setDefaultVal(parsedDefault.literal)
      setComment(column.comment ?? '')
    } else {
      setName('')
      setTypeSelect('VARCHAR(255)')
      setCustomType('')
      setNullable(true)
      setDefaultMode('none')
      setDefaultVal('')
      setComment('')
    }
    setError(null)
  }, [open, mode, column])

  const effectiveType = typeSelect === '__custom__' ? customType : typeSelect

  const handleSave = async () => {
    if (!name.trim()) { setError('Column name is required.'); return }
    if (!effectiveType.trim()) { setError('Column type is required.'); return }
    const modeError = defaultModeError(defaultMode, effectiveType, nullable)
    if (modeError) {
      setError(modeError)
      return
    }
    setError(null)
    try {
      const defaultValue = defaultMode === 'none'
        ? null
        : defaultMode === 'null'
          ? 'NULL'
          : defaultMode === 'literal'
            ? defaultVal
            : defaultMode
      const payload = {
        name: name.trim(),
        type: effectiveType.trim(),
        nullable,
        default: defaultValue,
        ...(defaultMode === 'literal' ? { default_is_literal: true } : {}),
        comment: comment || undefined,
      }
      if (mode === 'add') {
        await api.addColumn(sessionId, database, table, payload)
      } else {
        await api.modifyColumn(sessionId, database, table, column!.name, payload)
      }

      let refreshError: unknown
      try {
        await onSaved()
      } catch (e) {
        refreshError = e
      }
      const message = mode === 'add'
        ? `Column ${payload.name} added.`
        : `Column ${payload.name} updated.`
      showToast(
        refreshError
          ? `${message} Schema refresh failed: ${String(refreshError)}`
          : message,
        refreshError ? 'error' : 'success',
      )
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

        <Select
          label="Default"
          value={defaultMode}
          onChange={e => setDefaultMode(e.target.value as DefaultMode)}
        >
          {DEFAULT_MODE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>

        {defaultMode === 'literal' && (
          <Input
            label="Literal Value"
            value={defaultVal}
            onChange={e => setDefaultVal(e.target.value)}
            placeholder="e.g. pending"
          />
        )}

        {defaultMode !== 'none' && defaultMode !== 'literal' && (
          <p className="text-[11px] text-slate-500">
            Expression defaults require compatible column types. UUID() and RAND() may be blocked by statement-based replication.
          </p>
        )}

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
