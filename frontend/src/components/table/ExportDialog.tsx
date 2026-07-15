/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { clipboardWrite } from '../../utils/clipboard'
import { apiFetch } from '../../api/client'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Select from '../ui/Select'
import Input from '../ui/Input'
import { showToast } from '../../utils/toast'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table: string
  /** When provided, export runs this SQL instead of SELECT * FROM table */
  sql?: string
  /** When provided, export only these rows (identified by PK values) */
  pkValues?: Record<string, unknown>[]
  /** When provided, bypass backend and export these pre-fetched (filtered) rows */
  rowsOverride?: { columns: string[], rows: unknown[][] }
  /** Human-readable description for rowsOverride rows */
  rowsOverrideLabel?: string
  /** PK column names used for DELETE SQL generation when rowsOverride is set */
  pkColumnsForSql?: string[]
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  return `'${String(v).split("'").join("''")}'`
}

function quoteIdent(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

export const buildQualifiedTableName = (database: string, table: string, includeSchema = false): string => {
  return includeSchema
    ? `${quoteIdent(database)}.${quoteIdent(table)}`
    : quoteIdent(table)
}

export const buildFrontendContent = (
  format: 'insert' | 'delete' | 'delete+insert' | 'csv',
  database: string,
  table: string,
  data: { columns: string[], rows: unknown[][] },
  pkCols: string[],
  csvOpts: { delimiter: string, quoteChar: string, escapeChar: string, lineTerminator: string, encoding: string },
  insertMode: 'batch' | 'single' = 'batch',
  includeSchema = false,
): string => {
  if (format === 'csv') {
    const { delimiter: d, quoteChar: q, escapeChar: e, lineTerminator: nl } = csvOpts
    // CSV formula injection (=, +, -, @ prefix) is intentionally not sanitized —
    // this is a DB admin tool and users are exporting their own data.
    const escape = (v: unknown, forceQuote = false) => {
      const s = v === null || v === undefined ? '' : String(v)
      if (!q) {
        // QUOTE_NONE: mirrors Python csv.QUOTE_NONE — no quoting, but escape
        // the delimiter and newlines with escapechar so fields aren't split.
        if (!e) return s
        const selfEscaped = s.split(e).join(e + e)
        return selfEscaped
          .split(d).join(e + d)
          .replace(/\r\n/g, e + '\r\n')
          .replace(/\r(?!\n)/g, e + '\r')
          .replace(/(?<!\r)\n/g, e + '\n')
      }
      // When using a separate escapechar (e.g. backslash), values containing it
      // must be quoted and the escapechar self-escaped, or a parser misreads the
      // following character as an escape sequence (e.g. C:\path → \p interpreted).
      const hasEscapechar = !!(e && e !== q && s.includes(e))
      if (!forceQuote && !hasEscapechar && !(s.includes(d) || s.includes(q) || s.includes('\n') || s.includes('\r'))) return s
      // Pre-escape the escapechar first, then escape the quotechar. Order matters:
      // doing it in reverse would double-escape the backslashes we just inserted.
      const inner = hasEscapechar ? s.split(e).join(e + e) : s
      return q + inner.split(q).join(e + q) + q
    }
    const header = data.columns.map(c => escape(c, true)).join(d)
    const body = [header, ...data.rows.map(r => r.map(v => escape(v)).join(d))].join(nl)
    return csvOpts.encoding === 'utf-8-sig' ? '\uFEFF' + body : body
  }

  if (format === 'insert') {
    const target = buildQualifiedTableName(database, table, includeSchema)
    const cols = data.columns.map(quoteIdent).join(', ')
    if (insertMode === 'single') {
      return data.rows.map(r => {
        const vals = `(${r.map(sqlLiteral).join(', ')})`
        return `INSERT INTO ${target} (${cols}) VALUES ${vals};\n`
      }).join('')
    }
    const values = data.rows.map(r => `(${r.map(sqlLiteral).join(', ')})`).join(',\n')
    return `INSERT INTO ${target} (${cols}) VALUES\n${values};\n`
  }

  const target = buildQualifiedTableName(database, table, includeSchema)
  const effectivePks = pkCols.length > 0 ? pkCols : data.columns
  const deleteLines = data.rows.map(r => {
    const where = effectivePks
      .map(pk => {
        const idx = data.columns.indexOf(pk)
        return `${quoteIdent(pk)} = ${sqlLiteral(idx >= 0 ? r[idx] : null)}`
      })
      .join(' AND ')
    return `DELETE FROM ${target} WHERE ${where};`
  }).join('\n')

  if (format === 'delete') return deleteLines + '\n'

  // delete+insert
  const cols = data.columns.map(quoteIdent).join(', ')
  if (insertMode === 'single') {
    return data.rows.map(r => {
      const idx = effectivePks.map(pk => data.columns.indexOf(pk))
      const where = effectivePks
        .map((pk, i) => `${quoteIdent(pk)} = ${sqlLiteral(idx[i] >= 0 ? r[idx[i]] : null)}`)
        .join(' AND ')
      const vals = `(${r.map(sqlLiteral).join(', ')})`
      return `DELETE FROM ${target} WHERE ${where};\n` +
             `INSERT INTO ${target} (${cols}) VALUES ${vals};\n`
    }).join('')
  }
  const values = data.rows.map(r => `(${r.map(sqlLiteral).join(', ')})`).join(',\n')
  return deleteLines + '\n\n' + `INSERT INTO ${target} (${cols}) VALUES\n${values};\n`
}

export default function ExportDialog({ open, onClose, sessionId, database, table, sql: customSql, pkValues, rowsOverride, rowsOverrideLabel = 'filtered rows', pkColumnsForSql = [] }: Props) {
  const [format, setFormat] = useState<'insert' | 'delete' | 'delete+insert' | 'csv'>(customSql ? 'csv' : 'insert')
  const [insertMode, setInsertMode] = useState<'batch' | 'single'>('single')
  const [batchSize, setBatchSize] = useState('500')
  const [includeSchema, setIncludeSchema] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // CSV advanced options
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [csvDelimiter, setCsvDelimiter] = useState(',')
  const [csvDelimiterCustom, setCsvDelimiterCustom] = useState('')
  const [csvQuotechar, setCsvQuotechar] = useState('"')
  const [csvEscapechar, setCsvEscapechar] = useState('"')
  const [csvLineterminator, setCsvLineterminator] = useState('crlf')
  const [csvEncoding, setCsvEncoding] = useState('utf-8')

  // Map line ending names to actual characters
  const lineTerminatorMap: Record<string, string> = {
    crlf: '\r\n',
    lf: '\n',
    cr: '\r',
  }
  const effectiveLineterminator = lineTerminatorMap[csvLineterminator] || '\r\n'

  const effectiveDelimiter = csvDelimiter === 'custom' ? csvDelimiterCustom : csvDelimiter

  const buildBody = () => {
    const parsedBatchSize = parseInt(batchSize, 10)
    return JSON.stringify({
      database,
      ...(customSql ? { sql: customSql } : { table }),
      format,
      batch_size: Number.isNaN(parsedBatchSize) || parsedBatchSize < 1 ? 500 : parsedBatchSize,
      ...(format === 'insert' || format === 'delete+insert' ? { insert_mode: insertMode } : {}),
      ...(format !== 'csv' ? { include_schema: includeSchema } : {}),
      ...(pkValues ? { pk_values: pkValues } : {}),
      ...(format === 'csv' ? {
        csv_delimiter: effectiveDelimiter,
        csv_quotechar: csvQuotechar,
        csv_escapechar: csvEscapechar,
        csv_lineterminator: effectiveLineterminator,
        csv_encoding: csvEncoding,
      } : {}),
    })
  }

  const getCsvOpts = () => ({
    delimiter: effectiveDelimiter,
    quoteChar: csvQuotechar,
    escapeChar: csvEscapechar,
    lineTerminator: effectiveLineterminator,
    encoding: csvEncoding,
  })

  const handleExport = async () => {
    setExporting(true)
    setError(null)
    try {
      let blob: Blob
      let filename: string
      if (rowsOverride) {
        const content = buildFrontendContent(format, database, table, rowsOverride, pkColumnsForSql, getCsvOpts(), insertMode, includeSchema)
        blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        filename = `${database}_${table}_filtered.${format === 'csv' ? 'csv' : 'sql'}`
      } else {
        const res = await apiFetch(`/api/v1/sessions/${sessionId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(),
        })
        if (!res.ok) throw new Error(await res.text())
        blob = await res.blob()
        const cd = res.headers.get('Content-Disposition') ?? ''
        const match = cd.match(/filename="([^"]+)"/)
        filename = match ? match[1] : `${database}_${table}.${format === 'csv' ? 'csv' : 'sql'}`
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.download = filename
      a.href = url
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      onClose()
    } catch (e) {
      const message = `Export failed: ${e}`
      setError(message)
      showToast(message, 'error')
    } finally {
      setExporting(false)
    }
  }

  const handleCopy = async () => {
    setCopying(true)
    setError(null)
    try {
      let text: string
      if (rowsOverride) {
        text = buildFrontendContent(format, database, table, rowsOverride, pkColumnsForSql, getCsvOpts(), insertMode, includeSchema)
      } else {
        const res = await apiFetch(`/api/v1/sessions/${sessionId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(),
        })
        if (!res.ok) throw new Error(await res.text())
        const blob = await res.blob()
        text = await blob.text()
      }
      await clipboardWrite(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      const message = `Copy failed: ${e}`
      setError(message)
      showToast(message, 'error')
    } finally {
      setCopying(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Export ${database}.${table}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="ghost" onClick={handleCopy} disabled={copying || exporting}>
            {copied ? 'Copied! ✓' : copying ? 'Copying…' : 'Copy'}
          </Button>
          <Button variant="primary" onClick={handleExport} disabled={exporting || copying}>
            {exporting ? 'Exporting…' : error ? 'Retry Download' : 'Download'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p role="alert" className="rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-200">{error}</p>}
        <Select
          label="Format"
          value={format}
          onChange={e => setFormat(e.target.value as typeof format)}
        >
          {!customSql && <option value="insert">INSERT SQL</option>}
          {!customSql && <option value="delete">DELETE SQL</option>}
          {!customSql && <option value="delete+insert">DELETE + INSERT SQL</option>}
          <option value="csv">CSV</option>
        </Select>
        {(format === 'insert' || format === 'delete+insert') && (
          <Select
            label="INSERT Mode"
            value={insertMode}
            onChange={e => setInsertMode(e.target.value as typeof insertMode)}
          >
            <option value="batch">Batch (all rows in one INSERT)</option>
            <option value="single">Single (one INSERT per row)</option>
          </Select>
        )}
        {format !== 'csv' && (
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeSchema}
              onChange={e => setIncludeSchema(e.target.checked)}
              className="accent-brand-500"
            />
            <span>Include schema name</span>
          </label>
        )}
        <Input
          label="Batch Size"
          type="number"
          value={batchSize}
          onChange={e => setBatchSize(e.target.value)}
        />
        {format === 'csv' && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Advanced CSV Options
            </button>
            {showAdvanced && (
              <div className="mt-3 flex flex-col gap-3 pl-4 border-l border-surface-700">
                <div className="flex gap-3">
                  <Select
                    label="Delimiter"
                    value={csvDelimiter}
                    onChange={e => setCsvDelimiter(e.target.value)}
                  >
                    <option value=",">Comma (,)</option>
                    <option value=";">Semicolon (;)</option>
                    <option value="\t">Tab</option>
                    <option value="|">Pipe (|)</option>
                    <option value="custom">Custom</option>
                  </Select>
                  {csvDelimiter === 'custom' && (
                    <Input
                      label="Custom"
                      value={csvDelimiterCustom}
                      onChange={e => setCsvDelimiterCustom(e.target.value.slice(0, 1))}
                      className="w-16"
                    />
                  )}
                </div>
                <div className="flex gap-3">
                  <Select
                    label="Quote Character"
                    value={csvQuotechar}
                    onChange={e => setCsvQuotechar(e.target.value)}
                  >
                    <option value='"'>Double Quote (&quot;)</option>
                    <option value="'">Single Quote (&apos;)</option>
                    <option value="">None</option>
                  </Select>
                  <Select
                    label="Escape Character"
                    value={csvEscapechar}
                    onChange={e => setCsvEscapechar(e.target.value)}
                  >
                    <option value='"'>Double Quote (&quot;)</option>
                    <option value={"\\"}>{String.raw`Backslash (\)`}</option>
                    <option value="">None</option>
                  </Select>
                </div>
                <div className="flex gap-3">
                  <Select
                    label="Line Ending"
                    value={csvLineterminator}
                    onChange={e => setCsvLineterminator(e.target.value)}
                  >
                    <option value="crlf">CRLF (Windows)</option>
                    <option value="lf">LF (Unix/Mac)</option>
                    <option value="cr">CR (Legacy Mac)</option>
                  </Select>
                  <Select
                    label="Encoding"
                    value={csvEncoding}
                    onChange={e => setCsvEncoding(e.target.value)}
                  >
                    <option value="utf-8">UTF-8</option>
                    <option value="utf-8-sig">UTF-8 with BOM</option>
                    <option value="ascii">ASCII</option>
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-slate-500">
          {rowsOverride
            ? <>Exporting <strong className="text-slate-300">{rowsOverride.rows.length} {rowsOverrideLabel}</strong> from <code className="text-slate-300">{table}</code>.</>
            : pkValues
              ? <>Exporting <strong className="text-slate-300">{pkValues.length} selected rows</strong> from <code className="text-slate-300">{table}</code>.</>
              : <>Exports all rows from <code className="text-slate-300">{table}</code>. Large tables are streamed in batches.</>
          }
        </p>
      </div>
    </Modal>
  )
}
