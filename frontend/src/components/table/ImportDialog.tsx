import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, ChevronRight, ChevronDown } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Select from '../ui/Select'
import Input from '../ui/Input'
import { useSchemaStore } from '../../store/schemaStore'

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
}

interface Preview {
  columns: string[]
  rows: string[][]
  total_lines_sampled: number
}

export default function ImportDialog({ open, onClose, sessionId, database, table: preselectedTable, onImportComplete }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // CSV config
  const [delimiter, setDelimiter] = useState(',')
  const [delimiterCustom, setDelimiterCustom] = useState('')
  const [quotechar, setQuotechar] = useState('"')
  const [escapechar, setEscapechar] = useState('"')
  const [lineterminator, setLineterminator] = useState('crlf')
  const [encoding, setEncoding] = useState('utf-8')

  // Map line ending names to actual characters
  const lineTerminatorMap: Record<string, string> = {
    crlf: '\r\n',
    lf: '\n',
    cr: '\r',
  }
  const effectiveLineterminator = lineTerminatorMap[lineterminator] || '\r\n'

  // Import config
  const [firstRowHeader, setFirstRowHeader] = useState(true)
  const [targetTable, setTargetTable] = useState(preselectedTable ?? '')
  const [strategy, setStrategy] = useState<'insert' | 'insert_ignore' | 'replace'>('insert')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Status
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const tables = useSchemaStore(s => s.tables[`${sessionId}/${database}`] ?? [])
  const { loadTables } = useSchemaStore()

  useEffect(() => {
    loadTables(sessionId, database)
  }, [sessionId, database, loadTables])

  const effectiveDelimiter = delimiter === 'custom' ? delimiterCustom : delimiter

  const buildConfigJson = useCallback(() => JSON.stringify({
    database,
    table: targetTable,
    delimiter: effectiveDelimiter,
    quotechar,
    escapechar,
    lineterminator: effectiveLineterminator,
    encoding,
    first_row_header: firstRowHeader,
    strategy,
  }), [database, targetTable, effectiveDelimiter, quotechar, escapechar, effectiveLineterminator, encoding, firstRowHeader, strategy])

  // Fetch preview when file or CSV config changes
  const fetchPreviewTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (!file) { setPreview(null); setPreviewError(null); return }

    clearTimeout(fetchPreviewTimer.current)
    fetchPreviewTimer.current = setTimeout(async () => {
      setPreviewLoading(true)
      setPreviewError(null)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('config', buildConfigJson())
        const res = await fetch(`/api/v1/sessions/${sessionId}/import/preview`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          setPreviewError(await res.text())
          setPreview(null)
        } else {
          setPreview(await res.json())
          setPreviewError(null)
        }
      } catch (e) {
        setPreviewError(String(e))
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 300)

    return () => clearTimeout(fetchPreviewTimer.current)
  }, [file, effectiveDelimiter, quotechar, escapechar, lineterminator, encoding, firstRowHeader, sessionId, buildConfigJson])

  const handleFileSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      setFile(files[0])
      setResult(null)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    handleFileSelect(e.dataTransfer.files)
  }

  const handleImport = async () => {
    if (!file || !targetTable) return
    setImporting(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('config', buildConfigJson())
      const res = await fetch(`/api/v1/sessions/${sessionId}/import`, {
        method: 'POST',
        body: formData,
      })
      const data: ImportResult = await res.json()
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Import into ${database}${targetTable ? '.' + targetTable : ''}`}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={importing || !file || !targetTable}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* File drop zone */}
        <div
          className="border-2 border-dashed border-surface-700 rounded-lg p-6 text-center cursor-pointer hover:border-surface-600 transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            onChange={e => handleFileSelect(e.target.files)}
          />
          {file ? (
            <div className="text-sm">
              <Upload size={20} className="mx-auto mb-2 text-brand-400" />
              <p className="text-slate-200">{file.name}</p>
              <p className="text-xs text-slate-500 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div className="text-sm text-slate-500">
              <Upload size={20} className="mx-auto mb-2" />
              <p>Drop a CSV file here or click to select</p>
              <p className="text-xs mt-1">.csv, .tsv, .txt</p>
            </div>
          )}
        </div>

        {/* Preview */}
        {previewLoading && (
          <p className="text-xs text-slate-500">Loading preview…</p>
        )}
        {previewError && (
          <p className="text-xs text-red-400">{previewError}</p>
        )}
        {preview && (
          <div className="overflow-x-auto max-h-48 border border-surface-700 rounded">
            <table className="text-xs w-full">
              <thead>
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
        )}

        {/* Config section */}
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
          {showAdvanced && (
            <div className="mt-3 flex flex-col gap-3 pl-4 border-l border-surface-700">
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
                  label="Line Ending"
                  value={lineterminator}
                  onChange={e => setLineterminator(e.target.value)}
                >
                  <option value="crlf">CRLF (Windows)</option>
                  <option value="lf">LF (Unix/Mac)</option>
                  <option value="cr">CR (Legacy Mac)</option>
                </Select>
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
            </div>
          )}
        </div>

        {/* Result banner */}
        {result && (
          <div className={`p-3 rounded text-xs ${result.ok ? 'bg-green-900/30 border border-green-800 text-green-300' : 'bg-red-900/30 border border-red-800 text-red-300'}`}>
            {result.ok ? (
              <>
                Imported {result.rows_imported} rows via {result.method === 'load_data' ? 'LOAD DATA' : 'batch insert'}.
                {result.warnings && result.warnings.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-yellow-400">
                    {result.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
                    {result.warnings.length > 5 && <li>…and {result.warnings.length - 5} more</li>}
                  </ul>
                )}
              </>
            ) : (
              <>Import failed: {result.error}</>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
