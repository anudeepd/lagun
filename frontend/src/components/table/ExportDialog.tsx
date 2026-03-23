import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { clipboardWrite } from '../../utils/clipboard'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Select from '../ui/Select'
import Input from '../ui/Input'

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
}

export default function ExportDialog({ open, onClose, sessionId, database, table, sql: customSql, pkValues }: Props) {
  const [format, setFormat] = useState<'insert' | 'delete' | 'delete+insert' | 'csv'>(customSql ? 'csv' : 'insert')
  const [batchSize, setBatchSize] = useState('500')
  const [exporting, setExporting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)

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

  const buildBody = () => JSON.stringify({
    database,
    ...(customSql ? { sql: customSql } : { table }),
    format,
    batch_size: parseInt(batchSize),
    ...(pkValues ? { pk_values: pkValues } : {}),
    ...(format === 'csv' ? {
      csv_delimiter: effectiveDelimiter,
      csv_quotechar: csvQuotechar,
      csv_escapechar: csvEscapechar,
      csv_lineterminator: effectiveLineterminator,
      csv_encoding: csvEncoding,
    } : {}),
  })

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/v1/sessions/${sessionId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildBody(),
      })
      if (!res.ok) throw new Error(await res.text())

      // Stream to download
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const cd = res.headers.get('Content-Disposition') ?? ''
      const match = cd.match(/filename="([^"]+)"/)
      a.download = match ? match[1] : `${database}_${table}.${format === 'csv' ? 'csv' : 'sql'}`
      a.href = url
      a.click()
      URL.revokeObjectURL(url)
      onClose()
    } catch (e) {
      alert(`Export failed: ${e}`)
    } finally {
      setExporting(false)
    }
  }

  const handleCopy = async () => {
    setCopying(true)
    try {
      let text: string
      if (window.isSecureContext) {
        // Secure context: async fetch + navigator.clipboard works fine
        const res = await fetch(`/api/v1/sessions/${sessionId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(),
        })
        if (!res.ok) throw new Error(await res.text())
        const blob = await res.blob()
        text = await blob.text()
      } else {
        // Non-secure: sync XHR keeps the user gesture active so
        // the execCommand('copy') fallback in clipboardWrite works
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/v1/sessions/${sessionId}/export`, false)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.send(buildBody())
        if (xhr.status !== 200) throw new Error(xhr.responseText)
        text = xhr.responseText
      }
      await clipboardWrite(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      alert(`Copy failed: ${e}`)
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
            {exporting ? 'Exporting…' : 'Download'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
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
          {pkValues
            ? <>Exporting <strong className="text-slate-300">{pkValues.length} selected rows</strong> from <code className="text-slate-300">{table}</code>.</>
            : <>Exports all rows from <code className="text-slate-300">{table}</code>. Large tables are streamed in batches.</>
          }
        </p>
      </div>
    </Modal>
  )
}
