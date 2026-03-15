import { useState, useEffect } from 'react'
import { Pencil, Trash2, Plus, Download, AlertTriangle, Loader2, Copy, X, Code2, Key } from 'lucide-react'
import SyntaxHighlighter from 'react-syntax-highlighter'
import atomOneDark from 'react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark'
import Button from '../ui/Button'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import type { ColumnInfo, IndexInfo } from '../../types'
import EditColumnDialog from './EditColumnDialog'
import IndexDialog from './IndexDialog'
import PrimaryKeyDialog from './PrimaryKeyDialog'

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
    await navigator.clipboard.writeText(schemaSql)
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
    setTimeout(() => setStatusMsg(null), 3000)
  }

  const reload = async () => {
    setLoading(true)
    try {
      const [cols, idxs, tables] = await Promise.all([
        api.getColumns(sessionId, database, table),
        api.getIndexes(sessionId, database, table),
        api.getTables(sessionId, database),
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
  }

  useEffect(() => { reload() }, [sessionId, database, table])

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
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Loading schema…
      </div>
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
          {!confirmTruncate ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmTruncate(true)}>
              <AlertTriangle size={11} /> Truncate
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-yellow-400">Confirm truncate?</span>
              <Button variant="ghost" size="sm" onClick={handleTruncate}>Yes</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmTruncate(false)}>No</Button>
            </div>
          )}
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
                        confirmDropCol === col.name ? (
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleDropCol(col.name)} className="text-red-400 hover:text-red-300 text-xs">Drop</button>
                            <button onClick={() => setConfirmDropCol(null)} className="text-slate-500 hover:text-slate-300 text-xs">×</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDropCol(col.name)}
                            className="p-0.5 text-slate-500 hover:text-red-400 transition-colors"
                            title="Drop column"
                          >
                            <Trash2 size={11} />
                          </button>
                        )
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
                      confirmDropIdx === idx.name ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleDropIndex(idx.name)} className="text-red-400 hover:text-red-300 text-xs">Drop</button>
                          <button onClick={() => setConfirmDropIdx(null)} className="text-slate-500 hover:text-slate-300 text-xs">×</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDropIdx(idx.name)}
                          className="p-0.5 text-slate-500 hover:text-red-400 transition-colors"
                          title="Drop index"
                        >
                          <Trash2 size={11} />
                        </button>
                      )
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSchemaSql(null)}>
          <div className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-700">
              <span className="text-xs font-semibold text-slate-300">{database}.{table} — CREATE statement</span>
              <button onClick={() => setSchemaSql(null)} className="text-slate-500 hover:text-slate-200 transition-colors"><X size={14} /></button>
            </div>
            <div className="flex-1 overflow-auto bg-surface-950">
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
            <div className="flex items-center gap-2 px-4 py-2.5 border-t border-surface-700">
              <Button variant="ghost" size="sm" onClick={handleCopy}>
                <Copy size={11} /> {copied ? 'Copied!' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDownload}>
                <Download size={11} /> Download
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
