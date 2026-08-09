import { useState, useRef, useCallback, useEffect } from 'react'
import { CircleAlert, Upload, ChevronRight, ChevronDown } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import { LoadingState } from '../ui/Spinner'
import Select from '../ui/Select'
import Input from '../ui/Input'
import { useSchemaStore } from '../../store/schemaStore'
import { apiFetch } from '../../api/client'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  database: string
  table?: string
  onImportComplete?: () => void
}

interface ImportResult {
  ok: boolean
  rows_processed: number
  rows_imported: number
  method: string
  error?: string | null
  warnings?: string[]
  statements_processed?: number
  statements_succeeded?: number
  error_statement?: string | null
  error_line?: number | null
  partial?: boolean
}


function importResponseError(body: string, statusText: string): string {
  try {
    const payload = JSON.parse(body) as { detail?: unknown }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map(item => {
          if (!item || typeof item !== 'object') return String(item)
          const issue = item as { loc?: unknown[]; msg?: unknown }
          const location = Array.isArray(issue.loc) ? issue.loc.join('.') : ''
          return location ? `${location}: ${String(issue.msg ?? item)}` : String(issue.msg ?? item)
        })
        .join('\n')
    }
  } catch {
    // Keep plain response text below.
  }
  return body || statusText || 'Import request failed'
}
interface Preview {
  format?: 'csv' | 'mysql_dump'
  columns: string[]
  rows: string[][]
  total_lines_sampled: number
  statements?: { line: number; sql: string }[]
}

const PREVIEW_SAMPLE_BYTES = 1024 * 1024
const DRAG_OVERLAY_STALE_MS = 1_500
const DROP_DELAYED_MS = 15_000
type DropWaitState = 'preparing' | 'delayed' | null


export default function ImportDialog({ open, onClose, sessionId, database, table: preselectedTable, onImportComplete }: Props) {
  const [format, setFormat] = useState<'csv' | 'mysql_dump'>('csv')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // CSV config
  const [delimiter, setDelimiter] = useState(',')
  const [delimiterCustom, setDelimiterCustom] = useState('')
  const [quotechar, setQuotechar] = useState('"')
  const [escapechar, setEscapechar] = useState('"')
  const [encoding, setEncoding] = useState('utf-8')

  // Import config
  const [firstRowHeader, setFirstRowHeader] = useState(true)
  const [targetTable, setTargetTable] = useState(preselectedTable ?? '')
  const [strategy, setStrategy] = useState<'insert' | 'insert_ignore' | 'replace'>('insert')
  const [preserveEmptyStrings, setPreserveEmptyStrings] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Status
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [dropWaitState, setDropWaitState] = useState<DropWaitState>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragOverlayTimerRef = useRef<number | null>(null)
  const dropDelayTimerRef = useRef<number | null>(null)
  const tables = useSchemaStore(s => s.tables[`${sessionId}/${database}`] ?? [])
  const { loadTables } = useSchemaStore()

  useEffect(() => {
    loadTables(sessionId, database)
  }, [sessionId, database, loadTables])

  const effectiveDelimiter = delimiter === 'custom' ? delimiterCustom : delimiter

  const buildConfigJson = useCallback(() => JSON.stringify({
    database,
    format,
    ...(format === 'csv' ? {
      table: targetTable,
      delimiter: effectiveDelimiter,
      quotechar,
      escapechar,
      encoding,
      first_row_header: firstRowHeader,
      strategy,
      preserve_empty_strings: preserveEmptyStrings,
    } : {}),
  }), [database, format, targetTable, effectiveDelimiter, quotechar, escapechar, encoding, firstRowHeader, strategy, preserveEmptyStrings])

  const previewRequestId = useRef(0)
  useEffect(() => {
    previewRequestId.current += 1
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(false)
  }, [file, buildConfigJson])

  const clearDropFeedback = useCallback(() => {
    if (dragOverlayTimerRef.current !== null) {
      window.clearTimeout(dragOverlayTimerRef.current)
      dragOverlayTimerRef.current = null
    }
    if (dropDelayTimerRef.current !== null) {
      window.clearTimeout(dropDelayTimerRef.current)
      dropDelayTimerRef.current = null
    }
    setDropWaitState(null)
  }, [])

  const refreshDropFeedback = useCallback(() => {
    setDropWaitState(null)
    if (dragOverlayTimerRef.current !== null) window.clearTimeout(dragOverlayTimerRef.current)
    if (dropDelayTimerRef.current !== null) {
      window.clearTimeout(dropDelayTimerRef.current)
      dropDelayTimerRef.current = null
    }
    dragOverlayTimerRef.current = window.setTimeout(() => {
      dragOverlayTimerRef.current = null
      setDropWaitState('preparing')
      dropDelayTimerRef.current = window.setTimeout(() => {
        dropDelayTimerRef.current = null
        setDropWaitState('delayed')
      }, DROP_DELAYED_MS)
    }, DRAG_OVERLAY_STALE_MS)
  }, [])

  useEffect(() => {
    if (!open) {
      clearDropFeedback()
      return
    }
    const clearWhenHidden = () => {
      if (document.hidden) clearDropFeedback()
    }
    window.addEventListener('drop', clearDropFeedback)
    window.addEventListener('dragend', clearDropFeedback)
    window.addEventListener('blur', clearDropFeedback)
    document.addEventListener('visibilitychange', clearWhenHidden)
    return () => {
      window.removeEventListener('drop', clearDropFeedback)
      window.removeEventListener('dragend', clearDropFeedback)
      window.removeEventListener('blur', clearDropFeedback)
      document.removeEventListener('visibilitychange', clearWhenHidden)
      if (dragOverlayTimerRef.current !== null) window.clearTimeout(dragOverlayTimerRef.current)
      if (dropDelayTimerRef.current !== null) window.clearTimeout(dropDelayTimerRef.current)
    }
  }, [clearDropFeedback, open])

  const fetchPreview = async () => {
    if (!file) return
    const requestId = ++previewRequestId.current
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const sample = file.size > PREVIEW_SAMPLE_BYTES
        ? file.slice(0, PREVIEW_SAMPLE_BYTES, file.type)
        : file
      const formData = new FormData()
      formData.append('file', sample, file.name)
      formData.append('config', buildConfigJson())
      const res = await apiFetch(`/api/v1/sessions/${sessionId}/import/preview`, {
        method: 'POST',
        body: formData,
      })
      if (requestId !== previewRequestId.current) return
      if (!res.ok) {
        setPreviewError(importResponseError(await res.text(), res.statusText))
        setPreview(null)
      } else {
        setPreview(await res.json())
        setPreviewError(null)
      }
    } catch (error) {
      if (requestId !== previewRequestId.current) return
      setPreviewError(error instanceof Error ? error.message : String(error))
      setPreview(null)
    } finally {
      if (requestId === previewRequestId.current) setPreviewLoading(false)
    }
  }

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return
    clearDropFeedback()
    setFile(files[0])
    setResult(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    handleFileSelect(e.dataTransfer.files)
  }

  const handleImport = async () => {
    if (!file || (format === 'csv' && !targetTable)) return
    setImporting(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('config', buildConfigJson())
      const res = await apiFetch(`/api/v1/sessions/${sessionId}/import`, {
        method: 'POST',
        body: formData,
      })
      const body = await res.text()
      if (!res.ok) throw new Error(importResponseError(body, res.statusText))
      const data: ImportResult = JSON.parse(body)
      setResult(data)
      if (data.ok) {
        onImportComplete?.()
      }
    } catch (e) {
      setResult({ ok: false, rows_processed: 0, rows_imported: 0, method: 'unknown', error: String(e) })
    } finally {
      setImporting(false)
    }
  }

  const handleClose = () => {
    if (importing) return
    clearDropFeedback()
    onClose()
  }


  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={format === 'mysql_dump'
        ? `Import MySQL dump into ${database}`
        : `Import into ${database}${targetTable ? '.' + targetTable : ''}`}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={importing}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={importing || !file || (format === 'csv' && !targetTable)}
          >
            {importing ? 'Importing…' : result && !result.ok ? 'Retry Import' : 'Import'}
          </Button>
        </>
      }
    >
      <fieldset disabled={importing} className="flex flex-col gap-4">
        {/* File drop zone */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.txt,.sql,.dump"
          className="hidden"
          onChange={e => { handleFileSelect(e.target.files); e.currentTarget.value = '' }}
        />
        <button
          type="button"
          className="w-full border-2 border-dashed border-surface-700 rounded-lg p-6 text-center cursor-pointer hover:border-surface-600 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); refreshDropFeedback() }}
          onDragLeave={e => { if (e.currentTarget === e.target) clearDropFeedback() }}
          onDrop={handleDrop}
          aria-label={file ? `Selected file ${file.name}. Choose another file` : 'Choose import file'}
        >
          {file ? (
            <span className="block text-sm">
              <Upload size={20} className="mx-auto mb-2 text-brand-400" />
              <span className="block text-slate-200">{file.name}</span>
              <span className="block text-xs text-slate-500 mt-1">{(file.size / 1024).toFixed(1)} KB</span>
            </span>
          ) : (
            <span className="block text-sm text-slate-500">
              <Upload size={20} className="mx-auto mb-2" />
              <span className="block">Drop a CSV or MySQL dump file here or click to select</span>
              <span className="block text-xs mt-1">.csv, .tsv, .txt, .sql, .dump</span>
            </span>
          )}
        </button>
        {dropWaitState && (
          <div className="flex min-h-9 items-center gap-2 rounded border border-surface-700 border-l-2 border-l-brand-400 bg-surface-900 px-3 py-1.5 font-mono text-[11px] text-slate-300">
            {dropWaitState === 'preparing' ? (
              <LoadingState label="Preparing upload…" compact className="min-w-0 flex-1 justify-start py-0" />
            ) : (
              <>
                <CircleAlert size={14} className="flex-shrink-0 text-amber-400" />
                <span role="status" aria-live="polite" className="min-w-0 flex-1">Upload hasn't started yet.</span>
              </>
            )}
            {dropWaitState === 'delayed' && (
              <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>Choose file</Button>
            )}
            <Button variant="ghost" size="sm" onClick={clearDropFeedback}>Dismiss</Button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">Preview reads at most first 1 MB. Import still reads complete file.</p>
          <Button variant="ghost" size="sm" onClick={fetchPreview} disabled={!file || previewLoading}>
            {previewLoading ? 'Previewing…' : preview ? 'Refresh Preview' : 'Preview'}
          </Button>
        </div>

        {/* Preview */}
        {previewLoading && (
          <LoadingState label="Reading file preview…" compact className="justify-start py-2" />
        )}
        {previewError && (
          <p role="alert" className="text-xs text-red-400">{previewError}</p>
        )}
        {preview && preview.format === 'mysql_dump' ? (
          <div className="overflow-x-auto max-h-48 border border-surface-700 rounded p-2">
            <p className="text-xs text-slate-400 mb-2">Previewing up to 10 SQL statements</p>
            <ol className="text-xs font-mono text-slate-300 space-y-1">
              {(preview.statements ?? []).map((statement, i) => (
                <li key={i}><span className="text-slate-500">line {statement.line}:</span> {statement.sql}</li>
              ))}
            </ol>
          </div>
        ) : preview ? (
          <div className="overflow-auto max-h-48 border border-surface-700 rounded">
            <table className="text-xs w-full">
              <thead className="sticky top-0 z-10">
                <tr className="bg-surface-800">
                  {preview.columns.map((col, i) => (
                    <th key={i} className="px-2 py-1 text-left text-slate-300 font-medium whitespace-nowrap border-b border-surface-700">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, ri) => (
                  <tr key={ri} className="hover:bg-surface-800/50">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1 text-slate-400 whitespace-nowrap border-b border-surface-800">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.total_lines_sampled > preview.rows.length && (
              <p className="text-xs text-slate-500 px-2 py-1">Showing {preview.rows.length} of {preview.total_lines_sampled}+ rows</p>
            )}
          </div>
        ) : null}

        {/* Config section */}
        <Select
          label="File Format"
          value={format}
          onChange={e => {
            const next = e.target.value as 'csv' | 'mysql_dump'
            setFormat(next)
            setPreview(null)
            setResult(null)
          }}
        >
          <option value="csv">CSV / delimited text</option>
          <option value="mysql_dump">MySQL dump (.sql / .dump)</option>
        </Select>
        {format === 'csv' && (
          <>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Target Table"
            value={targetTable}
            onChange={e => setTargetTable(e.target.value)}
          >
            <option value="">Select table…</option>
            {tables.map(t => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </Select>
          <Select
            label="Import Strategy"
            value={strategy}
            onChange={e => setStrategy(e.target.value as typeof strategy)}
          >
            <option value="insert">INSERT (fail on duplicate)</option>
            <option value="insert_ignore">INSERT IGNORE (skip duplicates)</option>
            <option value="replace">REPLACE INTO (overwrite)</option>
          </Select>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={firstRowHeader}
            onChange={e => setFirstRowHeader(e.target.checked)}
            className="rounded border-surface-600 bg-surface-800 text-brand-500 focus:ring-brand-500"
          />
          First row contains column names
        </label>

        {/* Advanced CSV options */}
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            CSV Format Options
          </button>
          <AnimatePresence initial={false}>
          {showAdvanced && (
            <m.div initial={{ opacity: 0, height: 0, y: -motionDistance.subtle }} animate={{ opacity: 1, height: 'auto', y: 0, transition: surfaceTransition }} exit={{ opacity: 0, height: 0, y: -motionDistance.subtle, transition: exitTransition }} className="mt-3 flex flex-col gap-3 overflow-hidden pl-4 border-l border-surface-700">
              <div className="flex gap-3">
                <Select
                  label="Delimiter"
                  value={delimiter}
                  onChange={e => setDelimiter(e.target.value)}
                >
                  <option value=",">Comma (,)</option>
                  <option value=";">Semicolon (;)</option>
                  <option value="\t">Tab</option>
                  <option value="|">Pipe (|)</option>
                  <option value="custom">Custom</option>
                </Select>
                {delimiter === 'custom' && (
                  <Input
                    label="Custom"
                    value={delimiterCustom}
                    onChange={e => setDelimiterCustom(e.target.value.slice(0, 1))}
                    className="w-16"
                  />
                )}
              </div>
              <div className="flex gap-3">
                <Select
                  label="Quote Character"
                  value={quotechar}
                  onChange={e => setQuotechar(e.target.value)}
                >
                  <option value='"'>Double Quote (&quot;)</option>
                  <option value="'">Single Quote (&apos;)</option>
                  <option value="">None</option>
                </Select>
                <Select
                  label="Escape Character"
                  value={escapechar}
                  onChange={e => setEscapechar(e.target.value)}
                >
                  <option value='"'>Double Quote (&quot;)</option>
                  <option value="\\">Backslash (\)</option>
                  <option value="">None</option>
                </Select>
              </div>
              <div className="flex gap-3">
                <Select
                  label="Encoding"
                  value={encoding}
                  onChange={e => setEncoding(e.target.value)}
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-8-sig">UTF-8 with BOM</option>
                  <option value="ascii">ASCII</option>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={preserveEmptyStrings}
                  onChange={e => setPreserveEmptyStrings(e.target.checked)}
                  className="rounded border-surface-600 bg-surface-800 text-brand-500 focus:ring-brand-500"
                />
                Preserve blank fields as empty strings instead of NULL
              </label>
            </m.div>
          )}
          </AnimatePresence>
        </div>
          </>
        )}
        {format === 'mysql_dump' && (
          <p className="text-xs text-amber-300 bg-amber-950/30 border border-amber-800 rounded p-3">
            MySQL dump imports execute SQL from the file, including DDL and transaction/session statements. Review source before importing.
          </p>
        )}

        {/* Result banner */}
        {result && (
          <div role={result.ok ? 'status' : 'alert'} className={`p-3 rounded text-xs ${result.ok ? 'bg-green-900/30 border border-green-800 text-green-300' : 'bg-red-900/30 border border-red-800 text-red-300'}`}>
            {result.ok ? (
              <>
                {result.method === 'mysql_dump'
                  ? <>Executed {result.statements_succeeded ?? 0} of {result.statements_processed ?? 0} dump statements; {result.rows_imported} affected rows.</>
                  : <>Imported {result.rows_imported} rows via batch insert.</>}
                {result.warnings && result.warnings.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-yellow-400">
                    {result.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
                    {result.warnings.length > 5 && <li>…and {result.warnings.length - 5} more</li>}
                  </ul>
                )}
              </>
            ) : (
              <>
                Import failed{result.partial ? ' after partial execution' : ''}: {result.error}
                {result.error_line != null && <div>Source line: {result.error_line}</div>}
                {result.error_statement && <pre className="mt-1 whitespace-pre-wrap break-all">{result.error_statement}</pre>}
              </>
            )}
          </div>
        )}
      </fieldset>
    </Modal>
  )
}
