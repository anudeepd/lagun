import { useState, useEffect, useCallback } from 'react'
import { Pencil, Trash2, Plus, Download, AlertTriangle, Loader2, Copy, Code2, Key } from 'lucide-react'
import SyntaxHighlighter from 'react-syntax-highlighter'
import atomOneDark from 'react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark'
import Button from '../ui/Button'
import { LoadingState } from '../ui/Spinner'
import { clipboardWrite } from '../../utils/clipboard'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import type { ColumnInfo, IndexInfo } from '../../types'
import EditColumnDialog from './EditColumnDialog'
import IndexDialog from './IndexDialog'
import PrimaryKeyDialog from './PrimaryKeyDialog'
import Modal from '../ui/Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import { showToast } from '../../utils/toast'

interface Props {
  sessionId: string
  database: string
  table: string
}

function fmtBytes(bytes: number | null) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function TableSchemaView({ sessionId, database, table }: Props) {
  const { columns: colCache, loadColumns, invalidateTable } = useSchemaStore()
  const colKey = `${sessionId}/${database}/${table}`
  const cachedCols = colCache[colKey]

  const [columns, setColumns] = useState<ColumnInfo[]>(cachedCols ?? [])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [tableInfo, setTableInfo] = useState<import('../../types').TableInfo | null>(null)
  const [loading, setLoading] = useState(!cachedCols)

  const [editCol, setEditCol] = useState<ColumnInfo | null>(null)
  const [showAddCol, setShowAddCol] = useState(false)
  const [showAddIndex, setShowAddIndex] = useState(false)
  const [showManagePK, setShowManagePK] = useState(false)
  const [confirmTruncate, setConfirmTruncate] = useState(false)
  const [confirmDropCol, setConfirmDropCol] = useState<string | null>(null)
  const [confirmDropIdx, setConfirmDropIdx] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [schemaSql, setSchemaSql] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const formatSchemaSql = (rawSql: string, tbl: string) => {
    const withIfNotExists = rawSql.replace(/^CREATE TABLE\b/i, 'CREATE TABLE IF NOT EXISTS')
    return `DROP TABLE IF EXISTS \`${tbl}\`;\n${withIfNotExists};`
  }

  const openSchemaExport = async () => {
    const { create_sql } = await api.getCreateSql(sessionId, database, table)
    setSchemaSql(formatSchemaSql(create_sql, table))
  }

  const handleCopy = async () => {
    if (!schemaSql) return
    await clipboardWrite(schemaSql)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    if (!schemaSql) return
    const blob = new Blob([schemaSql + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${database}_${table}_create.sql`
    a.click()
    URL.revokeObjectURL(url)
  }

  const flash = (msg: string) => {
    setStatusMsg(msg)
    showToast(msg, msg.startsWith('Error') ? 'error' : 'success')
    setTimeout(() => setStatusMsg(null), 3000)
  }

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const [cols, idxs, tables] = await Promise.all([
        api.getColumns(sessionId, database, table, signal),
        api.getIndexes(sessionId, database, table, signal),
        api.getTables(sessionId, database, signal),
      ])
      setColumns(cols)
      setIndexes(idxs)
      setTableInfo(tables.find(t => t.name === table) ?? null)
      // bust store cache so autocomplete and sidebar see fresh data
      invalidateTable(sessionId, database, table)
      loadColumns(sessionId, database, table)
    } finally {
      setLoading(false)
    }
  }, [sessionId, database, table, invalidateTable, loadColumns])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => controller.abort()
  }, [sessionId, database, table, reload])

  const handleTruncate = async () => {
    try {
      await api.truncateTable(sessionId, database, table)
      flash('Table truncated.')
    } catch (e) { flash(String(e)) }
    setConfirmTruncate(false)
  }

  const handleDropCol = async (col: string) => {
    try {
      await api.dropColumn(sessionId, database, table, col)
      flash(`Column ${col} dropped.`)
      reload()
    } catch (e) { flash(String(e)) }
    setConfirmDropCol(null)
  }

  const handleDropIndex = async (idx: string) => {
    try {
      await api.dropIndex(sessionId, database, table, idx)
      flash(`Index ${idx} dropped.`)
      setIndexes(prev => prev.filter(i => i.name !== idx))
    } catch (e) { flash(String(e)) }
    setConfirmDropIdx(null)
  }

  if (loading && columns.length === 0) {
    return (
      <LoadingState label={`Loading columns, indexes, and table details for ${table}…`} />
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">

      {/* Table info bar */}
      {tableInfo && (
        <div className="flex items-center gap-4 px-3 py-2 bg-surface-800 rounded-md border border-surface-700 text-xs text-slate-400">
          {tableInfo.engine && <span>Engine: <span className="text-slate-200">{tableInfo.engine}</span></span>}
          {tableInfo.row_count != null && (
            <span>~Rows: <span className="text-slate-200">{tableInfo.row_count.toLocaleString()}</span></span>
          )}
          <span>Data: <span className="text-slate-200">{fmtBytes(tableInfo.data_length)}</span></span>
          {tableInfo.comment && <span className="text-slate-500 italic">{tableInfo.comment}</span>}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setConfirmTruncate(true)}>
            <AlertTriangle size={11} /> Truncate
          </Button>
          <Button variant="ghost" size="sm" onClick={openSchemaExport}>
            <Code2 size={11} /> Export Schema
          </Button>
        </div>
      )}

      {/* Columns section */}
      <section className={loading ? 'opacity-60' : ''}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
            Columns
            {loading && <Loader2 size={11} className="animate-spin" />}
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowManagePK(true)}>
              <Key size={11} /> Manage PK
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowAddCol(true)}>
              <Plus size={11} /> Add Column
            </Button>
          </div>
        </div>
        <div className="border border-surface-700 rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-800 text-slate-400">
              <tr>
                {['Name', 'Type', 'Nullable', 'Default', 'Key', 'Extra', 'Comment', ''].map(h => (
                  <th key={h} className="text-left px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map(col => (
                <tr key={col.name} className="border-t border-surface-700 hover:bg-surface-800/50">
                  <td className="px-2 py-1.5 font-mono text-slate-200">{col.name}</td>
                  <td className="px-2 py-1.5 text-slate-300">{col.column_type}</td>
                  <td className="px-2 py-1.5 text-slate-400">{col.is_nullable ? 'YES' : 'NO'}</td>
                  <td className="px-2 py-1.5 text-slate-400 font-mono">{col.column_default ?? <span className="italic text-slate-600">NULL</span>}</td>
                  <td className="px-2 py-1.5 text-slate-400">{col.is_primary_key ? 'PRI' : ''}</td>
                  <td className="px-2 py-1.5 text-slate-400">{col.extra}</td>
                  <td className="px-2 py-1.5 text-slate-500 italic">{col.comment}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditCol(col)}
                        className="p-0.5 text-slate-500 hover:text-slate-200 transition-colors"
                        title="Edit column"
                      >
                        <Pencil size={11} />
                      </button>
                      {!col.is_primary_key && (
                        <button
                          onClick={() => setConfirmDropCol(col.name)}
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          title={`Drop column ${col.name}`}
                          aria-label={`Drop column ${col.name}`}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Indexes section */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Indexes</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowAddIndex(true)}>
            <Plus size={11} /> Add Index
          </Button>
        </div>
        <div className="border border-surface-700 rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-800 text-slate-400">
              <tr>
                {['Name', 'Columns', 'Unique', 'Type', ''].map(h => (
                  <th key={h} className="text-left px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {indexes.map(idx => (
                <tr key={idx.name} className="border-t border-surface-700 hover:bg-surface-800/50">
                  <td className="px-2 py-1.5 font-mono text-slate-200">{idx.name}</td>
                  <td className="px-2 py-1.5 text-slate-300">{idx.columns.join(', ')}</td>
                  <td className="px-2 py-1.5 text-slate-400">{idx.is_unique ? 'YES' : 'NO'}</td>
                  <td className="px-2 py-1.5 text-slate-400">{idx.index_type}</td>
                  <td className="px-2 py-1.5">
                    {idx.name !== 'PRIMARY' && (
                      <button
                        onClick={() => setConfirmDropIdx(idx.name)}
                        className="p-1 text-slate-500 hover:text-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        title={`Drop index ${idx.name}`}
                        aria-label={`Drop index ${idx.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {indexes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-3 text-center text-slate-600 italic">No indexes</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {statusMsg && (
        <div className="px-3 py-1.5 bg-surface-800 rounded text-xs font-mono text-slate-400">
          {statusMsg}
        </div>
      )}

      <EditColumnDialog
        open={showAddCol}
        onClose={() => setShowAddCol(false)}
        sessionId={sessionId}
        database={database}
        table={table}
        mode="add"
        onSaved={reload}
      />

      {editCol && (
        <EditColumnDialog
          open={!!editCol}
          onClose={() => setEditCol(null)}
          sessionId={sessionId}
          database={database}
          table={table}
          mode="modify"
          column={editCol}
          onSaved={() => { reload(); setEditCol(null) }}
        />
      )}

      <IndexDialog
        open={showAddIndex}
        onClose={() => { setShowAddIndex(false); reload() }}
        sessionId={sessionId}
        database={database}
        table={table}
        columns={columns.map(c => c.name)}
      />

      <PrimaryKeyDialog
        open={showManagePK}
        onClose={() => { setShowManagePK(false); reload() }}
        sessionId={sessionId}
        database={database}
        table={table}
        columns={columns.map(c => c.name)}
        currentPkColumns={indexes.find(i => i.name === 'PRIMARY')?.columns ?? []}
      />

      {schemaSql && (
        <Modal
          open={true}
          onClose={() => setSchemaSql(null)}
          title={`${database}.${table} - CREATE statement`}
          width="max-w-3xl"
          footer={(
            <>
              <Button variant="ghost" size="sm" onClick={handleCopy}>
                <Copy size={11} /> {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDownload}>
                <Download size={11} /> Download
              </Button>
            </>
          )}
        >
          <div className="-m-4 flex-1 overflow-auto bg-surface-950">
            <SyntaxHighlighter
              language="sql"
              style={atomOneDark}
              customStyle={{
                margin: 0,
                padding: '1rem',
                fontSize: '12px',
                fontFamily: 'ui-monospace, monospace',
                backgroundColor: '#0f172a',
              }}
              wrapLines={true}
              lineProps={{ style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }}
            >
              {schemaSql}
            </SyntaxHighlighter>
          </div>
        </Modal>
      )}
      <ConfirmDialog
        open={confirmTruncate}
        title="Truncate Table"
        message={`Truncate ${database}.${table}? All rows will be permanently deleted.`}
        confirmLabel="Truncate Table"
        danger
        onConfirm={handleTruncate}
        onClose={() => setConfirmTruncate(false)}
      />
      <ConfirmDialog
        open={confirmDropCol !== null}
        title="Drop Column"
        message={`Drop column ${confirmDropCol ?? ''} from ${database}.${table}? Existing data in this column will be permanently deleted.`}
        confirmLabel="Drop Column"
        danger
        onConfirm={() => confirmDropCol && handleDropCol(confirmDropCol)}
        onClose={() => setConfirmDropCol(null)}
      />
      <ConfirmDialog
        open={confirmDropIdx !== null}
        title="Drop Index"
        message={`Drop index ${confirmDropIdx ?? ''} from ${database}.${table}?`}
        confirmLabel="Drop Index"
        danger
        onConfirm={() => confirmDropIdx && handleDropIndex(confirmDropIdx)}
        onClose={() => setConfirmDropIdx(null)}
      />

    </div>
  )
}
