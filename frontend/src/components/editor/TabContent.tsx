import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import type { Tab, QueryResult, ColumnInfo } from '../../types'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import { useQueryLogStore } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import QueryEditor from './QueryEditor'
import ResultGrid, { type ResultGridHandle } from './ResultGrid'
import ResultToolbar from './ResultToolbar'
import { RefreshCw, Download, Upload, Search, Filter, X } from 'lucide-react'
import Button from '../ui/Button'
import ReactCodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

const TableSchemaView = lazy(() => import('../table/TableSchemaView'))
const ExportDialog = lazy(() => import('../table/ExportDialog'))
const ImportDialog = lazy(() => import('../table/ImportDialog'))
const LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000]

interface Props {
  tab: Tab
}

export default function TabContent({ tab }: Props) {
  if (tab.type === 'query') {
    return <QueryTab tab={tab} />
  }
  return <TableTab tab={tab} />
}

function QueryTab({ tab }: Props) {
  const storeSql = useTabStore(s => s.tabs.find(t => t.id === tab.id)?.sql ?? '')
  const setSqlStore = useTabStore(s => s.setSql)
  const [sql, setSql] = useState(storeSql)
  const sqlRef = useRef(sql)
  sqlRef.current = sql

  // Debounce sync to store (and thus localStorage) — 500ms
  useEffect(() => {
    const timer = setTimeout(() => setSqlStore(tab.id, sql), 500)
    return () => clearTimeout(timer)
  }, [sql, tab.id, setSqlStore])

  // Flush on unmount so switching tabs doesn't lose the latest keystroke
  useEffect(() => {
    return () => { setSqlStore(tab.id, sqlRef.current) }
  }, [tab.id, setSqlStore])

  // Re-initialize local state when switching to a different tab's content
  useEffect(() => { setSql(storeSql) }, [tab.id])

  const [result, setResult] = useState<QueryResult | null>(null)
  const [running, setRunning] = useState(false)
  const [limit, setLimit] = useState(1000)
  const [showExport, setShowExport] = useState(false)
  const [exportOverride, setExportOverride] = useState<{ columns: string[], rows: unknown[][] } | undefined>()
  const gridRef = useRef<ResultGridHandle>(null)
  const { tables, columns, loadTables, loadColumns } = useSchemaStore()
  const addEntry = useQueryLogStore(s => s.addEntry)

  const schema = useMemo(() => {
    if (!tab.database) return {}
    const tbls = tables[`${tab.sessionId}/${tab.database}`] ?? []
    const result: Record<string, string[]> = {}
    for (const tbl of tbls) {
      const key = `${tab.sessionId}/${tab.database}/${tbl.name}`
      result[tbl.name] = (columns[key] ?? []).map(c => c.name)
    }
    return result
  }, [tab.sessionId, tab.database, tables, columns])

  // Load table names eagerly (single fast request)
  useEffect(() => {
    if (!tab.database) return
    loadTables(tab.sessionId, tab.database)
  }, [tab.sessionId, tab.database])

  // Lazy: load columns only for tables referenced in the current SQL
  useEffect(() => {
    if (!tab.database) return
    const timer = setTimeout(() => {
      const matches = [...sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?(?:\w+`?\.`?)?(\w+)`?/gi)]
      // Also catch comma-separated tables: FROM t1, t2 or UPDATE t1, t2
      const commaMatches = [...sql.matchAll(/,\s*`?(?:\w+`?\.`?)?(\w+)`?\s*(?:AS\s+\w+\s*)?(?:,|WHERE\b|SET\b|ON\b|$)/gi)]
      const names = [...new Set([...matches, ...commaMatches].map(m => m[1]))]
      for (const name of names) {
        loadColumns(tab.sessionId, tab.database!, name)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [sql, tab.sessionId, tab.database])

  const run = async () => {
    if (!sql.trim()) return
    setRunning(true)
    const start = Date.now()
    try {
      const r = await api.executeQuery(tab.sessionId, sql, tab.database, limit)
      setResult(r)
      addEntry({
        sql: sql.trim(),
        sessionId: tab.sessionId,
        database: tab.database,
        rowCount: r.row_count ?? undefined,
        execTimeMs: r.exec_time_ms ?? (Date.now() - start),
        error: r.error ?? undefined,
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-48 flex-shrink-0 border-b border-surface-800">
        <QueryEditor
          value={sql}
          onChange={setSql}
          onRun={run}
          running={running}
          database={tab.database}
          schema={schema}
          limit={limit}
          onLimitChange={setLimit}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {result ? (
          <ResultGrid ref={gridRef} result={result} />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-600 text-sm">
            Press Ctrl+Enter to run a query
          </div>
        )}
      </div>
      <div className="flex items-center border-t border-surface-800">
        <div className="flex-1">
          <ResultToolbar result={result} running={running} />
        </div>
        {result && !result.error && result.columns.length > 0 && (
          <button
            onClick={() => {
              setExportOverride(
                gridRef.current?.isAnyFilterPresent() ? gridRef.current.getFilteredData() : undefined
              )
              setShowExport(true)
            }}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            title="Export result"
          >
            <Download size={11} /> Export
          </button>
        )}
      </div>

      {showExport && tab.database && sql.trim() && (
        <Suspense fallback={null}>
          <ExportDialog
            open={showExport}
            onClose={() => setShowExport(false)}
            sessionId={tab.sessionId}
            database={tab.database}
            table="result"
            sql={sql.trim()}
            rowsOverride={exportOverride}
          />
        </Suspense>
      )}
    </div>
  )
}

function TableTab({ tab }: Props) {
  const [view, setView] = useState<'schema' | 'data'>('schema')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [initialLoading, setInitialLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [limit, setLimit] = useState(1000)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([])
  const [showDataExport, setShowDataExport] = useState(false)
  const [exportOverride, setExportOverride] = useState<{ columns: string[], rows: unknown[][] } | undefined>()
  const gridRef = useRef<ResultGridHandle>(null)
  const [showImport, setShowImport] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const [whereFilter, setWhereFilter] = useState('')
  const [appliedWhere, setAppliedWhere] = useState('')
  const [showFilterBar, setShowFilterBar] = useState(false)
  const addEntry = useQueryLogStore(s => s.addEntry)

  const pkColumns = columns.filter(c => c.is_primary_key).map(c => c.name)

  const loadData = async (overrideLimit?: number, searchOverride?: string, whereOverride?: string) => {
    if (!tab.database || !tab.table) return
    const effectiveLimit = overrideLimit ?? limit
    const effectiveSearch = searchOverride !== undefined ? searchOverride : globalSearch
    const effectiveWhere = whereOverride !== undefined ? whereOverride : appliedWhere

    setSelectedRows([])

    if (result === null) {
      setInitialLoading(true)
    } else {
      setRefreshing(true)
    }

    const start = Date.now()
    try {
      // Fetch columns first so we can build LIKE conditions across all columns
      const cols = await api.getColumns(tab.sessionId, tab.database, tab.table)
      setColumns(cols)

      let selectSql = `SELECT * FROM \`${tab.database}\`.\`${tab.table}\``
      const conditions: string[] = []

      if (effectiveSearch.trim() && cols.length > 0) {
        const escaped = effectiveSearch.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')
        const likeParts = cols.map(c => `\`${c.name}\` LIKE '%${escaped}%'`)
        conditions.push(`(${likeParts.join(' OR ')})`)
      }

      if (effectiveWhere.trim()) {
        conditions.push(`(${effectiveWhere.trim()})`)
      }

      if (conditions.length > 0) {
        selectSql += ` WHERE ${conditions.join(' AND ')}`
      }

      const res = await api.executeQuery(tab.sessionId, selectSql, undefined, effectiveLimit)
      setResult(res)
      addEntry({
        sql: selectSql,
        sessionId: tab.sessionId,
        database: tab.database,
        rowCount: res.row_count ?? undefined,
        execTimeMs: res.exec_time_ms ?? (Date.now() - start),
        error: res.error ?? undefined,
      })
    } finally {
      setInitialLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (view === 'data' && !result) {
      loadData()
    }
  }, [view])

  useEffect(() => {
    setView('schema')
    setResult(null)
    setColumns([])
    setGlobalSearch('')
    setWhereFilter('')
    setAppliedWhere('')
    setShowFilterBar(false)
  }, [tab.sessionId, tab.database, tab.table])

  // Debounced global search — re-queries server on every keystroke pause
  useEffect(() => {
    if (view !== 'data') return
    const timer = setTimeout(() => {
      loadData(undefined, globalSearch, appliedWhere)
    }, 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSearch])

  const handleCellEdit = async (params: { column: string; newValue: unknown; data: Record<string, unknown> }) => {
    if (!tab.database || !tab.table || pkColumns.length === 0) return
    const primary_key: Record<string, unknown> = {}
    pkColumns.forEach(pk => { primary_key[pk] = params.data[pk] })

    const start = Date.now()
    const r = await api.cellUpdate(tab.sessionId, {
      database: tab.database,
      table: tab.table,
      primary_key,
      column: params.column,
      new_value: params.newValue,
    })
    if (r.ok) {
      setStatusMsg(`✓ ${r.sql_executed}`)
      addEntry({
        sql: r.sql_executed,
        sessionId: tab.sessionId,
        database: tab.database,
        affectedRows: r.affected_rows ?? undefined,
        execTimeMs: Date.now() - start,
      })
      loadData()
    } else {
      setStatusMsg(`✗ ${r.error}`)
      addEntry({
        sql: r.sql_executed || `UPDATE ${tab.database}.${tab.table}`,
        sessionId: tab.sessionId,
        database: tab.database,
        execTimeMs: Date.now() - start,
        error: r.error ?? undefined,
      })
    }
    setTimeout(() => setStatusMsg(null), 4000)
  }

  const handleDeleteRows = async (rows: Record<string, unknown>[]) => {
    if (!tab.database || !tab.table || pkColumns.length === 0) return
    const primary_keys = rows.map(row => Object.fromEntries(pkColumns.map(pk => [pk, row[pk]])))
    const r = await api.rowDelete(tab.sessionId, {
      database: tab.database,
      table: tab.table,
      primary_keys,
    })
    if (r.ok) {
      setStatusMsg(`✓ Deleted ${r.affected_rows} row${r.affected_rows !== 1 ? 's' : ''}`)
      addEntry({
        sql: `DELETE FROM \`${tab.database}\`.\`${tab.table}\` (${r.affected_rows} row${r.affected_rows !== 1 ? 's' : ''})`,
        sessionId: tab.sessionId,
        database: tab.database,
        affectedRows: r.affected_rows,
        execTimeMs: 0,
      })
      loadData()
    } else {
      setStatusMsg(`✗ ${r.error}`)
    }
    setTimeout(() => setStatusMsg(null), 4000)
  }

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit)
    if (result) loadData(newLimit)
  }

  const handleApplyFilter = useCallback(() => {
    setAppliedWhere(whereFilter)
    loadData(undefined, globalSearch, whereFilter)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whereFilter, globalSearch])

  const handleClearFilter = () => {
    setWhereFilter('')
    setAppliedWhere('')
    loadData(undefined, globalSearch, '')
  }

  const handleClearSearch = () => {
    setGlobalSearch('')
    // The debounce useEffect will trigger loadData with empty search
  }

  // Stable ref so the CodeMirror keymap extension never needs to be recreated
  const applyFilterRef = useRef(handleApplyFilter)
  applyFilterRef.current = handleApplyFilter

  // SQL keywords/operators for the filter bar (no schema — we handle columns separately below)
  const filterSqlExtension = useMemo(() => sql({ dialect: MySQL }), [])

  // Column name completions registered directly on the MySQL language so they
  // merge with keyword completions rather than replacing them
  const filterColumnCompletionExtension = useMemo(() => {
    const options = columns.map(c => ({ label: c.name, type: 'property' as const, boost: 99 }))
    return MySQL.language.data.of({
      autocomplete: (context: CompletionContext): CompletionResult | null => {
        const word = context.matchBefore(/\w+/)
        if (!word && !context.explicit) return null
        return { from: word ? word.from : context.pos, options, validFor: /^\w*$/ }
      },
    })
  }, [columns])

  const filterKeymapExtension = useMemo(() =>
    Prec.highest(keymap.of([
      { key: 'Enter',     run: () => { applyFilterRef.current(); return true } },
      { key: 'Mod-Enter', run: () => { applyFilterRef.current(); return true } },
    ])),
  [])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-900 border-b border-surface-800">
        <span className="text-xs text-slate-400">{tab.database}.{tab.table}</span>
        <div className="flex-1" />
        {/* Global search input — shown in data view */}
        {view === 'data' && (
          <div className="relative flex items-center">
            <Search size={11} className="absolute left-2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              placeholder="Search all columns…"
              className="bg-surface-800 border border-surface-700 rounded pl-6 pr-6 py-0.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500 w-44"
            />
            {globalSearch && (
              <button onClick={handleClearSearch} className="absolute right-1.5 text-slate-500 hover:text-slate-300">
                <X size={10} />
              </button>
            )}
          </div>
        )}
        {/* Filter toggle button */}
        {view === 'data' && (
          <button
            onClick={() => setShowFilterBar(v => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${showFilterBar || appliedWhere ? 'text-brand-400 bg-brand-950 border border-brand-800' : 'text-slate-500 hover:text-slate-300'}`}
            title="Toggle WHERE filter"
          >
            <Filter size={11} />
            {appliedWhere ? 'Filtered' : 'Filter'}
          </button>
        )}
        {/* Limit selector — only shown in data view */}
        {view === 'data' && (
          <div className="flex items-center gap-1 text-xs text-slate-500">
            <span>Limit</span>
            <select
              value={limit}
              onChange={e => handleLimitChange(Number(e.target.value))}
              className="bg-surface-800 border border-surface-700 rounded px-1.5 py-0.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {LIMIT_OPTIONS.map(n => (
                <option key={n} value={n}>{n.toLocaleString()}</option>
              ))}
            </select>
          </div>
        )}
        {/* Refreshing badge */}
        {view === 'data' && refreshing && (
          <RefreshCw size={12} className="animate-spin text-slate-400" />
        )}
        {/* View toggle */}
        <div className="flex rounded overflow-hidden border border-surface-700">
          <button
            className={`px-2.5 py-0.5 text-xs transition-colors ${view === 'schema' ? 'bg-brand-600 text-white' : 'bg-surface-800 text-slate-400 hover:text-slate-200'}`}
            onClick={() => setView('schema')}
          >
            Schema
          </button>
          <button
            className={`px-2.5 py-0.5 text-xs transition-colors ${view === 'data' ? 'bg-brand-600 text-white' : 'bg-surface-800 text-slate-400 hover:text-slate-200'}`}
            onClick={() => setView('data')}
          >
            Data
          </button>
        </div>
        {view === 'data' && (
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            title="Import data"
          >
            <Upload size={11} /> Import
          </button>
        )}
        {view === 'data' && result && !result.error && (
          <button
            onClick={() => {
              if (selectedRows.length === 0 && gridRef.current?.isAnyFilterPresent()) {
                setExportOverride(gridRef.current.getFilteredData())
              } else {
                setExportOverride(undefined)
              }
              setShowDataExport(true)
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            title="Export data"
          >
            <Download size={11} /> Export
          </button>
        )}
        {view === 'data' && (
          <Button variant="ghost" size="sm" onClick={() => loadData()} title="Refresh" disabled={initialLoading || refreshing}>
            <RefreshCw size={12} className={initialLoading || refreshing ? 'animate-spin' : ''} />
          </Button>
        )}
      </div>

      {/* WHERE filter bar */}
      {view === 'data' && showFilterBar && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-900 border-b border-surface-700">
          <span className="text-xs text-slate-500 font-mono shrink-0">WHERE</span>
          <div className="flex-1 rounded overflow-hidden border border-surface-700 focus-within:ring-1 focus-within:ring-brand-500">
            <ReactCodeMirror
              value={whereFilter}
              onChange={val => {
                setWhereFilter(val)
                if (!val.trim() && appliedWhere) {
                  setAppliedWhere('')
                  loadData(undefined, globalSearch, '')
                }
              }}
              extensions={[filterSqlExtension, filterColumnCompletionExtension, filterKeymapExtension]}
              theme={oneDark}
              height="28px"
              placeholder="e.g. id = 5 AND name LIKE 'John%'"
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                autocompletion: true,
              }}
            />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-slate-500 bg-surface-800 border border-surface-700 rounded">
              Ctrl+↵
            </kbd>
            <button
              onClick={handleApplyFilter}
              className="px-2.5 py-0.5 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded transition-colors"
            >
              Apply
            </button>
          </div>
          {appliedWhere && (
            <button
              onClick={handleClearFilter}
              className="px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {view === 'schema' && tab.database && tab.table ? (
          <Suspense fallback={<div className="flex items-center justify-center h-full text-slate-500 text-sm">Loading schema…</div>}>
            <TableSchemaView
              sessionId={tab.sessionId}
              database={tab.database}
              table={tab.table}
            />
          </Suspense>
        ) : view === 'data' ? (
          initialLoading ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-sm">
              Loading {tab.table}…
            </div>
          ) : result ? (
            <ResultGrid
              ref={gridRef}
              result={result}
              editable={pkColumns.length > 0}
              primaryKeyColumns={pkColumns}
              onCellEdit={handleCellEdit}
              onDeleteRows={handleDeleteRows}
              selectable={true}
              onSelectionChange={setSelectedRows}
              columns={columns}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-600 text-sm">
              No data loaded
            </div>
          )
        ) : null}
      </div>

      {statusMsg && (
        <div className="px-3 py-1.5 bg-surface-900 border-t border-surface-800">
          <p className="text-xs font-mono text-slate-400 truncate">{statusMsg}</p>
        </div>
      )}

      {view === 'data' && result && <ResultToolbar result={result} running={false} />}

      {showDataExport && tab.database && tab.table && (
        <Suspense fallback={null}>
          <ExportDialog
            open={showDataExport}
            onClose={() => setShowDataExport(false)}
            sessionId={tab.sessionId}
            database={tab.database}
            table={tab.table}
            pkValues={selectedRows.length > 0
              ? selectedRows.map(r => {
                  // Fall back to all columns if no primary key (HeidiSQL approach)
                  const keyCols = pkColumns.length > 0 ? pkColumns : columns.map(c => c.name)
                  return Object.fromEntries(keyCols.map(col => [col, r[col]]))
                })
              : undefined}
            rowsOverride={exportOverride}
            pkColumnsForSql={pkColumns}
          />
        </Suspense>
      )}

      {showImport && tab.database && (
        <Suspense fallback={null}>
          <ImportDialog
            open={showImport}
            onClose={() => setShowImport(false)}
            sessionId={tab.sessionId}
            database={tab.database}
            table={tab.table}
            onImportComplete={() => loadData()}
          />
        </Suspense>
      )}
    </div>
  )
}
