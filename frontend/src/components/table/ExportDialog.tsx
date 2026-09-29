/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { clipboardWrite } from '../../utils/clipboard'
import { API_BASE, api, apiFetch, errorMessageFromResponse } from '../../api/client'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Progress from '../ui/Progress'
import Select from '../ui/Select'
import Input from '../ui/Input'
import { showToast } from '../../utils/toast'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'
import type { ExportOverrideData } from '../../types'

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
  rowsOverride?: ExportOverrideData
  /** Human-readable description for rowsOverride rows */
  rowsOverrideLabel?: string
  /** PK column names used for DELETE SQL generation when rowsOverride is set */
  pkColumnsForSql?: string[]
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  const s = String(v)
  // MySQL treats backslash as an escape character (NO_BACKSLASH_ESCAPES is off
  // by default), so `'C:\Users'` would lose the backslash on replay and a value
  // ending in one would escape the closing quote. A hex literal needs no
  // escaping and stays charset-correct; `CONVERT(... USING utf8mb4)` keeps it
  // text rather than binary so the server can still convert it to the column's
  // charset.
  if (s.includes('\\') || s.includes('\u0000') || s.includes('\u001a')) {
    const hex = Array.from(new TextEncoder().encode(s))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return `CONVERT(0x${hex} USING utf8mb4)`
  }
  return `'${s.split("'").join("''")}'`
}

function sqlPredicate(column: string, value: unknown): string {
  return value === null || value === undefined
    ? `${quoteIdent(column)} IS NULL`
    : `${quoteIdent(column)} = ${sqlLiteral(value)}`
}

function quoteIdent(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

export const buildQualifiedTableName = (database: string, table: string, includeSchema = false): string => {
  return includeSchema
    ? `${quoteIdent(database)}.${quoteIdent(table)}`
    : quoteIdent(table)
}

// Characters that make a spreadsheet treat a cell as a formula.
const CSV_FORMULA_PREFIXES = '=+-@\u0009\u000d'

/**
 * Neutralises CSV formula injection (CWE-1236) for one CSV cell or header.
 *
 * A value that starts with `=`, `+`, `-`, `@`, TAB or CR is prefixed with a
 * single apostrophe so Excel, LibreOffice and Sheets read it as text. This
 * matters even though users export their own data: Lagun supports shared
 * connections where several LDAP users work on the same tables, so one user can
 * store a crafted value that another user later exports and opens.
 *
 * Values that are genuinely numeric (`-5`, `+1.5`, `-1e6`) are left untouched so
 * numbers survive the round-trip as numbers. Empty values stay empty. The rule
 * matches the backend CSV generator — the frontend and backend exports must
 * neutralise identically.
 */
export function neutralizeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (s === '' || CSV_FORMULA_PREFIXES.indexOf(s[0]) === -1) return s
  // `Number('')` is 0 and `Number('\t')` is 0, so reject whitespace-only strings
  // explicitly: a bare TAB/CR is not a number and must still be neutralised.
  const trimmed = s.trim()
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return s
  return `'${s}`
}

export const buildFrontendContent = (
  format: 'insert' | 'delete' | 'delete+insert' | 'csv',
  database: string,
  table: string,
  data: ExportOverrideData,
  pkCols: string[],
  csvOpts: { delimiter: string, quoteChar: string, escapeChar: string, lineTerminator: string, encoding: string },
  insertMode: 'batch' | 'single' = 'batch',
  includeSchema = false,
  includeAutoIncrement = true,
): string => {
  // Auto-increment columns are excluded from the INSERT column list / VALUES and
  // the CSV header/rows when the checkbox is unchecked. DELETE WHERE clauses
  // always reference primary keys against the unfiltered row values regardless
  // of this setting. When autoIncrementColumns is absent (e.g. raw query
  // results), no AI filter is applied.
  const autoInc = new Set(data.autoIncrementColumns ?? [])
  const filterAi = !includeAutoIncrement && autoInc.size > 0
  const colIdx = new Map(data.columns.map((c, i) => [c, i]))
  const outCols = filterAi ? data.columns.filter(c => !autoInc.has(c)) : data.columns
  const outRows = filterAi
    ? data.rows.map(row => outCols.map(c => row[colIdx.get(c) ?? -1]))
    : data.rows

  if (format === 'csv') {
    const { delimiter: d, quoteChar: q, escapeChar: e, lineTerminator: nl } = csvOpts
    const escape = (v: unknown, forceQuote = false) => {
      // Neutralise formula prefixes before quoting/escaping so the apostrophe we
      // add is part of the value the quoting logic sees (and quotes if needed).
      const s = neutralizeCsvCell(v)
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
    const header = outCols.map(c => escape(c, true)).join(d)
    const body = [header, ...outRows.map(r => r.map(v => escape(v)).join(d))].join(nl)
    return csvOpts.encoding === 'utf-8-sig' ? '\uFEFF' + body : body
  }

  if (format === 'insert') {
    const target = buildQualifiedTableName(database, table, includeSchema)
    const cols = outCols.map(quoteIdent).join(', ')
    if (insertMode === 'single') {
      return outRows.map(r => {
        const vals = `(${r.map(sqlLiteral).join(', ')})`
        return `INSERT INTO ${target} (${cols}) VALUES ${vals};\n`
      }).join('')
    }
    const values = outRows.map(r => `(${r.map(sqlLiteral).join(', ')})`).join(',\n')
    return `INSERT INTO ${target} (${cols}) VALUES\n${values};\n`
  }

  const target = buildQualifiedTableName(database, table, includeSchema)
  const effectivePks = pkCols.length > 0 ? pkCols : data.columns
  const deleteLines = data.rows.map(r => {
    const where = effectivePks
      .map(pk => {
        const idx = data.columns.indexOf(pk)
        return sqlPredicate(pk, idx >= 0 ? r[idx] : null)
      })
      .join(' AND ')
    return `DELETE FROM ${target} WHERE ${where};`
  }).join('\n')

  if (format === 'delete') return deleteLines + '\n'

  // delete+insert: DELETE WHERE references PK cols against the unfiltered row;
  // only the INSERT column list / VALUES drop auto-increment columns.
  const cols = outCols.map(quoteIdent).join(', ')
  if (insertMode === 'single') {
    return data.rows.map((r, rowIdx) => {
      const idx = effectivePks.map(pk => data.columns.indexOf(pk))
      const where = effectivePks
        .map((pk, i) => sqlPredicate(pk, idx[i] >= 0 ? r[idx[i]] : null))
        .join(' AND ')
      const vals = `(${outRows[rowIdx].map(sqlLiteral).join(', ')})`
      return `DELETE FROM ${target} WHERE ${where};\n` +
             `INSERT INTO ${target} (${cols}) VALUES ${vals};\n`
    }).join('')
  }
  const values = outRows.map(r => `(${r.map(sqlLiteral).join(', ')})`).join(',\n')
  return deleteLines + '\n\n' + `INSERT INTO ${target} (${cols}) VALUES\n${values};\n`
}
const COPY_LIMIT_BYTES = 16 * 1024 * 1024

// Server markers. The SQL formats end with a completion line so a truncated
// download is detectable; a body that fails mid-stream (the HTTP status is
// already 200 by then) ends with a FAILED line instead. CSV has no comment
// syntax, so it can carry neither.
const EXPORT_FAILURE_MARKER = '-- Lagun export FAILED: '
const EXPORT_COMPLETION_RE = /\n-- Lagun export complete: \d+ rows\n$/

export async function responseTextWithLimit(response: Response, limit = COPY_LIMIT_BYTES): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new Blob([text]).size > limit) throw new Error(`Copy is limited to ${limit / 1024 / 1024} MB. Use Download for large exports.`)
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel()
      throw new Error(`Copy is limited to ${limit / 1024 / 1024} MB. Use Download for large exports.`)
    }
    parts.push(decoder.decode(value, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}


function beginNativeDownload(url: string, config: string, onError: (message: string) => void) {
  const target = `lagun-export-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const iframe = document.createElement('iframe')
  iframe.name = target
  iframe.title = 'Export download'
  iframe.hidden = true
  document.body.appendChild(iframe)

  const cleanup = () => iframe.remove()
  iframe.addEventListener('load', () => {
    if (iframe.contentWindow?.location.href === 'about:blank') return
    const message = iframe.contentDocument?.body.textContent?.trim()
    if (message) onError(message)
    cleanup()
  })
  window.addEventListener('pagehide', cleanup, { once: true })

  const form = document.createElement('form')
  form.method = 'POST'
  form.action = url
  form.target = target
  form.hidden = true
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'config'
  input.value = config
  form.appendChild(input)
  document.body.appendChild(form)
  form.submit()
  form.remove()
}

export default function ExportDialog({ open, onClose, sessionId, database, table, sql: customSql, pkValues, rowsOverride, rowsOverrideLabel = 'filtered rows', pkColumnsForSql = [] }: Props) {
  const [format, setFormat] = useState<'insert' | 'delete' | 'delete+insert' | 'csv'>(customSql ? 'csv' : 'insert')
  const [insertMode, setInsertMode] = useState<'batch' | 'single'>('single')
  const [batchSize, setBatchSize] = useState('500')
  const [includeSchema, setIncludeSchema] = useState(false)
  const [includeAutoIncrement, setIncludeAutoIncrement] = useState(false)
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
  const requestIdRef = useRef(0)

  // Callers keep this dialog mounted so Modal can play its exit animation, so a
  // fresh open no longer remounts and resets the form. Reset it here instead;
  // the reset lands while the dialog is still fully transparent.
  useEffect(() => {
    if (!open) {
      // Closing abandons whatever is still in flight: bumping here (only on the
      // close, never on an unrelated prop change) keeps a late copy or export
      // from closing or repainting the dialog on the next open.
      requestIdRef.current += 1
      return
    }
    setFormat(customSql ? 'csv' : 'insert')
    setInsertMode('single')
    setBatchSize('500')
    setIncludeSchema(false)
    setIncludeAutoIncrement(false)
    setExporting(false)
    setCopying(false)
    setCopied(false)
    setError(null)
    setShowAdvanced(false)
    setCsvDelimiter(',')
    setCsvDelimiterCustom('')
    setCsvQuotechar('"')
    setCsvEscapechar('"')
    setCsvLineterminator('crlf')
    setCsvEncoding('utf-8')
  }, [open, customSql])

  // Map line ending names to actual characters
  const lineTerminatorMap: Record<string, string> = {
    crlf: '\r\n',
    lf: '\n',
    cr: '\r',
  }
  const effectiveLineterminator = lineTerminatorMap[csvLineterminator] || '\r\n'

  const effectiveDelimiter = csvDelimiter === 'custom' ? csvDelimiterCustom : csvDelimiter

  // The AI-filter checkbox only affects INSERT/CSV output (DELETE-only has no
  // column list to filter) and only when the export source carries AI metadata.
  // With no rowsOverride the backend path applies the filter itself, so the
  // checkbox stays enabled there.
  const isDeleteOnly = format === 'delete'
  const hasAiInfo = rowsOverride
    ? !!(rowsOverride.autoIncrementColumns?.length)
    : !customSql
  const aiCheckboxDisabled = isDeleteOnly || !hasAiInfo

  const ensureValidCsvOptions = () => {
    if (format !== 'csv') return
    if (effectiveDelimiter === csvQuotechar || (csvEscapechar && effectiveDelimiter === csvEscapechar)) {
      throw new Error('CSV delimiter, quote, and escape characters must be compatible')
    }
  }

  const buildBody = () => {
    const parsedBatchSize = parseInt(batchSize, 10)
    return JSON.stringify({
      database,
      ...(customSql ? { sql: customSql } : { table }),
      format,
      exclude_auto_increment: !includeAutoIncrement,
      batch_size: Number.isNaN(parsedBatchSize) || parsedBatchSize < 1 || parsedBatchSize > 10_000 ? 500 : parsedBatchSize,
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
    const requestId = requestIdRef.current
    try {
      ensureValidCsvOptions()
      if (rowsOverride) {
        const content = buildFrontendContent(format, database, table, rowsOverride, pkColumnsForSql, getCsvOpts(), insertMode, includeSchema, includeAutoIncrement)
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.download = `${database}_${table}_filtered.${format === 'csv' ? 'csv' : 'sql'}`
        a.href = url
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else {
        beginNativeDownload(
          api.exportDownloadUrl(sessionId),
          buildBody(),
          message => {
            const errorMessage = `Export failed: ${message}`
            showToast(errorMessage, 'error')
          },
        )
      }
      if (requestId !== requestIdRef.current) return
      onClose()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (requestId !== requestIdRef.current) return
      const message = `Export failed: ${error instanceof Error ? error.message : String(error)}`
      setError(message)
      showToast(message, 'error')
    } finally {
      if (requestId === requestIdRef.current) setExporting(false)
    }
  }

  const handleCopy = async () => {
    setCopying(true)
    setError(null)
    const requestId = requestIdRef.current
    try {
      ensureValidCsvOptions()
      let text: string
      if (rowsOverride) {
        text = buildFrontendContent(format, database, table, rowsOverride, pkColumnsForSql, getCsvOpts(), insertMode, includeSchema, includeAutoIncrement)
        if (new Blob([text]).size > COPY_LIMIT_BYTES) {
          throw new Error('Copy is limited to 16 MB. Use Download for large exports.')
        }
      } else {
        // Kept on the raw Response rather than `api.exportText`: the copy path
        // streams the body so `responseTextWithLimit` can refuse anything over
        // 16 MB before it lands in memory (and in the clipboard).
        const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(),
        })
        if (!res.ok) throw new Error(await errorMessageFromResponse(res))
        text = await responseTextWithLimit(res)
        if (format !== 'csv') {
          // CSV has no comment syntax, so a truncated CSV cannot carry a marker
          // and there is nothing to verify here. The SQL formats end with a
          // completion line; a body that failed mid-stream ends with a FAILED
          // line instead (the status is already 200 by then).
          const failedAt = text.indexOf(EXPORT_FAILURE_MARKER)
          if (failedAt !== -1) {
            const message = text
              .slice(failedAt + EXPORT_FAILURE_MARKER.length)
              .split('\n', 1)[0]
            throw new Error(message || 'the export failed before it finished')
          }
          if (!EXPORT_COMPLETION_RE.test(text)) {
            throw new Error('the download ended before the export finished')
          }
        }
      }
      await clipboardWrite(text)
      if (requestId !== requestIdRef.current) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = `Copy failed: ${error instanceof Error ? error.message : String(error)}`
      setError(message)
      showToast(message, 'error')
    } finally {
      if (requestId === requestIdRef.current) setCopying(false)
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
        {/* The export response is an unbounded stream with no Content-Length, so
            a percentage cannot be honest; the bar stays indeterminate. */}
        {(exporting || copying) && (
          <Progress label={copying ? 'Copying export' : 'Exporting'} />
        )}
        {error && <p role="alert" className="rounded-md border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-200">{error}</p>}
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
            <option value="batch">Batch (bounded rows per INSERT)</option>
            <option value="single">Single (one INSERT per row)</option>
          </Select>
        )}
        {format !== 'csv' && (
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeSchema}
              onChange={e => setIncludeSchema(e.target.checked)}
              className="accent-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            />
            <span>Include schema name</span>
          </label>
        )}
        <label className={`flex items-center gap-2 text-sm text-slate-300 cursor-pointer ${aiCheckboxDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <input
            type="checkbox"
            checked={includeAutoIncrement}
            onChange={e => setIncludeAutoIncrement(e.target.checked)}
            disabled={aiCheckboxDisabled}
            className="accent-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-50 disabled:cursor-not-allowed"
            title="When unchecked, auto-increment columns are excluded from INSERT values and CSV output. DELETE WHERE clauses always reference primary keys (or all columns if no primary key exists) regardless of this setting. Has no effect for DELETE-only exports. Not available for query results or when auto-increment metadata is unavailable."
          />
          <span>Include auto-increment columns</span>
        </label>
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
              className="flex items-center gap-1 rounded text-xs text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Advanced CSV Options
            </button>
            <AnimatePresence initial={false}>
            {showAdvanced && (
              <m.div initial={{ opacity: 0, y: -motionDistance.subtle }} animate={{ opacity: 1, y: 0, transition: surfaceTransition }} exit={{ opacity: 0, y: -motionDistance.subtle, transition: exitTransition }} className="mt-3 flex flex-col gap-3 overflow-hidden pl-4 border-l border-surface-700">
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
              </m.div>
            )}
            </AnimatePresence>
          </div>
        )}
        <p className="text-pretty text-xs text-muted">
          {rowsOverride
            ? <>Exporting <strong className="text-slate-300">{rowsOverride.rows.length} {rowsOverrideLabel}</strong> from <code className="text-slate-300">{table}</code>.</>
            : pkValues
              ? <>Exporting <strong className="text-slate-300">{pkValues.length} selected rows</strong> from <code className="text-slate-300">{table}</code>.</>
              : <>Downloads all rows from <code className="text-slate-300">{table}</code> as a bounded-memory stream.</>
          }
          {format === 'csv' && (
            <>
              <br />
              CSV cells starting with <code className="text-slate-300">=</code>,{' '}
              <code className="text-slate-300">+</code>, <code className="text-slate-300">-</code>,{' '}
              <code className="text-slate-300">@</code>, tab or CR are prefixed with{' '}
              <code className="text-slate-300">&apos;</code> so a stored value cannot run as a
              spreadsheet formula when the file is opened; numeric values are left unchanged.
              <br />
              A CSV cell cannot carry both meanings at once: <code className="text-slate-300">NULL</code>{' '}
              and an empty string are both written as an empty field, so re-importing the file
              cannot restore which one was stored. Use the SQL format when that distinction
              matters.
            </>
          )}
          {!rowsOverride && <><br />Copy is capped at 16 MB. Download handles large exports without buffering them in this page.</>}
        </p>
      </div>
    </Modal>
  )
}
