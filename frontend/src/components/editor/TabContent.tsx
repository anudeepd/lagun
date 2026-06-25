import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import type { Tab, QueryResult, ColumnInfo, DataTabState } from '../../types'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import { useQueryLogStore } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'
import QueryEditor from './QueryEditor'
import ResultGrid, { buildResultGridRowId, type InsertDraftAnchor, type ResultGridHandle } from './ResultGrid'
import ResultToolbar from './ResultToolbar'
import { RefreshCw, Download, Upload, Search, Filter, X, Eye, WrapText, ArrowUpDown } from 'lucide-react'
import Button from '../ui/Button'
import ReactCodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { LIMIT_OPTIONS, SQL_KW, MYSQL_BUILTIN_OPTIONS } from '../../constants/sql'
import { isMac, modKey } from '../../utils/platform'

const TableSchemaView = lazy(() => import('../table/TableSchemaView'))
const ExportDialog = lazy(() => import('../table/ExportDialog'))
const ImportDialog = lazy(() => import('../table/ImportDialog'))

const KEY_WORD_WRAP = 'lagun-query-word-wrap'
const KEY_FILTER_WORD_WRAP = 'lagun-data-filter-word-wrap'
const KEY_EDITOR_HEIGHT = 'lagun-query-editor-height'

interface ExecutedQueryResult {
  id: string
  result: QueryResult
  sql: string
}

try {
  const oldWrap = localStorage.getItem('queryWordWrap')
  if (oldWrap !== null && localStorage.getItem(KEY_WORD_WRAP) === null) {
    localStorage.setItem(KEY_WORD_WRAP, oldWrap)
    localStorage.removeItem('queryWordWrap')
  }
  const oldHeight = localStorage.getItem('queryEditorHeight')
  if (oldHeight !== null && localStorage.getItem(KEY_EDITOR_HEIGHT) === null) {
    localStorage.setItem(KEY_EDITOR_HEIGHT, oldHeight)
    localStorage.removeItem('queryEditorHeight')
  }
} catch { /* localStorage unavailable (private browsing, etc.) */ }

interface Props {
  tab: Tab
}

export default function TabContent({ tab }: Props) {
  if (tab.type === 'query') {
    return <QueryTab tab={tab} />
  }
  return <TableTab tab={tab} />
}

function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingle = false, inDouble = false, inBacktick = false
  let inLineComment = false, inBlockComment = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1]
    if (inLineComment) { current += ch; if (ch === '\n') inLineComment = false; continue }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { current += '*/'; i++; inBlockComment = false }
      else current += ch
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'" && next === "'") { current += next; i++ }
      else if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) { current += ch; if (ch === '"') inDouble = false; continue }
    if (inBacktick) { current += ch; if (ch === '`') inBacktick = false; continue }
    if (ch === '-' && next === '-') { inLineComment = true; current += '--'; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; current += '/*'; i++; continue }
    if (ch === "'") { inSingle = true; current += ch; continue }
    if (ch === '"') { inDouble = true; current += ch; continue }
    if (ch === '`') { inBacktick = true; current += ch; continue }
    if (ch === ';') { const t = current.trim(); if (t) statements.push(t); current = ''; continue }
    current += ch
  }
  const t = current.trim()
  if (t) statements.push(t)
  return statements
}

export function shouldKeepPreviousResultOnLoad(nextResult: QueryResult, currentResult: QueryResult | null): boolean {
  return Boolean(nextResult.error && currentResult !== null)
}

export function normalizeDataTabState(state?: DataTabState): Required<DataTabState> {
  return {
    view: state?.view ?? 'schema',
    globalSearch: state?.globalSearch ?? '',
    whereFilter: state?.whereFilter ?? '',
    appliedWhere: state?.appliedWhere ?? '',
    showFilterBar: state?.showFilterBar ?? Boolean(state?.whereFilter || state?.appliedWhere),
    limit: state?.limit ?? 1000,
  }
}

export function buildQueryResultExportData(
  result: QueryResult | undefined,
  grid: Pick<ResultGridHandle, 'isAnyFilterPresent' | 'getFilteredData'> | null,
): { columns: string[], rows: unknown[][] } | undefined {
  if (!result) return undefined
  if (grid?.isAnyFilterPresent()) {
    return grid.getFilteredData()
  }
  return { columns: result.columns, rows: result.rows }
}

const MIN_EDITOR_HEIGHT = 100
const MAX_EDITOR_HEIGHT_FRACTION = 0.7

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

  const [results, setResults] = useState<ExecutedQueryResult[]>([])
  const [resultIdx, setResultIdx] = useState(0)
  const [running, setRunning] = useState(false)
  const [limit, setLimit] = useState(1000)
  const [functions, setFunctions] = useState<string[]>([])
  const [showExport, setShowExport] = useState(false)
  const [exportOverride, setExportOverride] = useState<{ columns: string[], rows: unknown[][] } | undefined>()
  const [resultSortActive, setResultSortActive] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const [editorHeight, setEditorHeight] = useState(() => {
    const saved = localStorage.getItem(KEY_EDITOR_HEIGHT)
    return saved ? Number(saved) : 192
  })
  const [wordWrap, setWordWrap] = useState(() => {
    const saved = localStorage.getItem(KEY_WORD_WRAP)
    return saved !== null ? saved === 'true' : true
  })
  const editorDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<ResultGridHandle>(null)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const { tables, columns, databases, loadDatabases, loadTables, loadColumns } = useSchemaStore()
  const setTabDatabase = useTabStore(s => s.setTabDatabase)
  const pendingSql = useTabStore(s => s.pendingSqls[tab.id])
  const consumePendingSql = useTabStore(s => s.consumePendingSql)
  const addEntry = useQueryLogStore(s => s.addEntry)

  // Load SQL injected from query log
  useEffect(() => {
    if (pendingSql !== undefined) {
      setSql(pendingSql.sql)
      if (pendingSql.database) setTabDatabase(tab.id, pendingSql.database)
      consumePendingSql(tab.id)
    }
  }, [pendingSql])

  useEffect(() => {
    setResultSortActive(false)
  }, [resultIdx, results.length])

  const session = useSessionStore(s => s.sessions.find(x => x.id === tab.sessionId))
  const allDbs = databases[tab.sessionId] ?? []
  const filteredDbs = session?.selected_databases?.length
    ? allDbs.filter(db => session.selected_databases!.includes(db))
    : allDbs
  // Always include the currently-active database even if it's outside selected_databases
  // (e.g. injected from query log)
  const dbList = tab.database && !filteredDbs.includes(tab.database)
    ? [...filteredDbs, tab.database]
    : filteredDbs

  useEffect(() => {
    loadDatabases(tab.sessionId)
  }, [tab.sessionId])

  // Synchronously extract alias→table map from the current SQL (no debounce needed — pure string parsing)
  const aliasMap = useMemo(() => {
    const map: Record<string, string> = {}
    // FROM/JOIN table [AS alias] or FROM/JOIN table alias (implicit MySQL syntax)
    // Captures: m[1]=tableName, m[2]=explicit AS alias, m[3]=implicit alias
    const fromJoinMatches = [...sql.matchAll(
      /(?:FROM|JOIN)\s+`?(?:\w+`?\.`?)?(\w+)`?(?:\s+AS\s+(\w+)|\s+(?!ON\b|WHERE\b|SET\b|INNER\b|LEFT\b|RIGHT\b|OUTER\b|CROSS\b|JOIN\b|HAVING\b|GROUP\b|ORDER\b|LIMIT\b|UNION\b|AND\b|OR\b|SELECT\b|INTO\b|USING\b)(\w+))?/gi
    )]
    for (const m of fromJoinMatches) {
      const alias = m[2] || m[3]
      if (alias && !SQL_KW.has(alias.toUpperCase())) map[alias] = m[1]
    }
    // Comma-separated tables: , table [AS alias] or , table alias
    // Captures: m[1]=tableName, m[2]=explicit AS alias, m[3]=implicit alias
    const commaMatches = [...sql.matchAll(
      /,\s*`?(?:\w+`?\.`?)?(\w+)`?(?:\s+AS\s+(\w+)|\s+(?!WHERE\b|SET\b|ON\b|LIMIT\b)(\w+))?(?:\s*,|\s+WHERE\b|\s+SET\b|\s+ON\b|\s+LIMIT\b|$)/gi
    )]
    for (const m of commaMatches) {
      const alias = m[2] || m[3]
      if (alias && !SQL_KW.has(alias.toUpperCase())) map[alias] = m[1]
    }
    return map
  }, [sql])

  const schema = useMemo(() => {
    if (!tab.database) return {}
    const tbls = tables[`${tab.sessionId}/${tab.database}`] ?? []
    const result: Record<string, string[]> = {}
    for (const tbl of tbls) {
      const key = `${tab.sessionId}/${tab.database}/${tbl.name}`
      result[tbl.name] = (columns[key] ?? []).map(c => c.name)
    }
    // Inject alias entries so `alias.col` completion works via schemaCompletionSource.
    // Skip if the alias name is already a real table (avoids clobbering real entries).
    for (const [alias, tableName] of Object.entries(aliasMap)) {
      if (result[tableName] && !result[alias]) {
        result[alias] = result[tableName]
      }
    }
    return result
  }, [tab.sessionId, tab.database, tables, columns, aliasMap])

  // Load table names eagerly (single fast request)
  useEffect(() => {
    if (!tab.database) return
    loadTables(tab.sessionId, tab.database)
  }, [tab.sessionId, tab.database])

  // Load user-defined functions for autocomplete
  useEffect(() => {
    if (!tab.database) return
    api.getFunctions(tab.sessionId, tab.database)
      .then(setFunctions)
      .catch(() => setFunctions([]))
  }, [tab.sessionId, tab.database])

  // Lazy: load columns only for tables referenced in the current SQL
  useEffect(() => {
    if (!tab.database) return
    const timer = setTimeout(() => {
      const fromJoinMatches = [...sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?(?:\w+`?\.`?)?(\w+)`?/gi)]
      const commaMatches = [...sql.matchAll(/,\s*`?(?:\w+`?\.`?)?(\w+)`?\s*(?:AS\s+\w+\s*)?(?:,|WHERE\b|SET\b|ON\b|LIMIT\b|$)/gi)]
      const names = [...new Set([...fromJoinMatches, ...commaMatches].map(m => m[1]))]
      for (const name of names) {
        loadColumns(tab.sessionId, tab.database!, name)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [sql, tab.sessionId, tab.database])

  const handleWordWrapChange = useCallback((wrap: boolean) => {
    setWordWrap(wrap)
    localStorage.setItem(KEY_WORD_WRAP, String(wrap))
  }, [])

  const handleEditorDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    editorDragRef.current = { startY: e.clientY, startHeight: editorHeight }
    const onMove = (ev: MouseEvent) => {
      if (!editorDragRef.current) return
      const containerHeight = editorContainerRef.current?.clientHeight ?? 600
      const maxH = Math.floor(containerHeight * MAX_EDITOR_HEIGHT_FRACTION)
      const next = Math.max(
        MIN_EDITOR_HEIGHT,
        Math.min(maxH, editorDragRef.current.startHeight + ev.clientY - editorDragRef.current.startY)
      )
      setEditorHeight(next)
      localStorage.setItem(KEY_EDITOR_HEIGHT, String(next))
    }
    const onUp = () => {
      editorDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Ask CodeMirror to remeasure layout after drag resize
      editorRef.current?.view?.requestMeasure()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const run = async () => {
    if (!sql.trim()) return

    const view = editorRef.current?.view
    const selection = view
      ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).trim()
      : ''
    const toRun = selection || sql.trim()
    const statements = splitStatements(toRun)
    if (statements.length === 0) return

    setRunning(true)
    const newResults: ExecutedQueryResult[] = []
    const executionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      for (const [statementIdx, stmt] of statements.entries()) {
        const controller = new AbortController()
        abortControllerRef.current = controller
        const start = Date.now()
        let r: QueryResult
        try {
          r = await api.executeQuery(tab.sessionId, stmt, tab.database, limit, controller.signal)
        } catch (e) {
          if ((e as Error).name === 'AbortError') {
            try { addEntry({ sql: stmt, sessionId: tab.sessionId, database: tab.database, execTimeMs: Date.now() - start, cancelled: true }) } catch { /* ignore localStorage errors */ }
            break
          }
          throw e
        }
        newResults.push({ id: `${executionId}-${statementIdx}`, result: r, sql: stmt })
        try {
          addEntry({
            sql: stmt,
            sessionId: tab.sessionId,
            database: tab.database,
            rowCount: r.row_count ?? undefined,
            execTimeMs: r.exec_time_ms ?? (Date.now() - start),
            error: r.error ?? undefined,
          })
        } catch { /* ignore localStorage errors */ }
        if (r.error) break
      }
    } finally {
      abortControllerRef.current = null
      setResults(newResults)
      setResultIdx(0)
      setRunning(false)
    }
  }

  const handleCancel = async () => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    try { await api.killQuery(tab.sessionId) } catch { /* ignore */ }
  }

  const getCurrentResultExportData = useCallback(() => {
    return buildQueryResultExportData(results[resultIdx]?.result, gridRef.current)
  }, [results, resultIdx])

  return (
    <div className="flex flex-col h-full min-h-0" ref={editorContainerRef}>
      <div style={{ height: editorHeight }} className="flex-shrink-0">
        <QueryEditor
          value={sql}
          onChange={setSql}
          onRun={run}
          onCancel={handleCancel}
          running={running}
          database={tab.database}
          databases={dbList}
          onDatabaseChange={db => setTabDatabase(tab.id, db)}
          schema={schema}
          functions={functions}
          limit={limit}
          onLimitChange={setLimit}
          editorRef={editorRef}
          wordWrap={wordWrap}
          onWordWrapChange={handleWordWrapChange}
        />
      </div>
      <div
        onMouseDown={handleEditorDividerMouseDown}
        className="h-1.5 flex-shrink-0 bg-surface-800 hover:bg-brand-500 cursor-row-resize transition-colors"
      />
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {results.length > 1 && (
          <div className="flex flex-shrink-0 bg-surface-900 border-b border-surface-800 overflow-x-auto">
            {results.map((entry, i) => (
              <button
                key={i}
                onClick={() => setResultIdx(i)}
                className={`px-3 py-1 text-xs whitespace-nowrap border-r border-surface-800 transition-colors ${
                  resultIdx === i
                    ? 'bg-surface-950 text-slate-200 border-t-2 border-t-brand-500'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800'
                }`}
              >
                {entry.result.error
                  ? `✗ Result ${i + 1}`
                  : entry.result.columns.length > 0
                    ? `Result ${i + 1} (${entry.result.row_count} rows)`
                    : `Result ${i + 1} (${entry.result.affected_rows ?? 0} affected)`}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-hidden min-h-0">
          {results.length > 0 ? (
            <ResultGrid
              key={results[resultIdx].id}
              ref={gridRef}
              result={results[resultIdx].result}
              onSortActiveChange={setResultSortActive}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-600 text-sm">
              Press {isMac ? '⌘Enter' : 'Ctrl+Enter'} to run a query
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center border-t border-surface-800">
        <div className="flex-1">
          <ResultToolbar result={results[resultIdx]?.result ?? null} running={running} />
        </div>
        {results[resultIdx] && !results[resultIdx].result.error && results[resultIdx].result.columns.length > 0 && (
          <div className="flex items-center">
            <button
              onClick={() => gridRef.current?.clearSort()}
              disabled={!resultSortActive}
              className={`flex items-center gap-1 px-3 py-1.5 text-xs transition-colors disabled:cursor-default ${
                resultSortActive
                  ? 'text-brand-400 hover:text-brand-300'
                  : 'text-slate-600'
              }`}
              title="Clear result sorting"
            >
              <ArrowUpDown size={11} /> Clear Sort
            </button>
            <button
              onClick={() => {
                setExportOverride(getCurrentResultExportData())
                setShowExport(true)
              }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              title="Export result"
            >
              <Download size={11} /> Export
            </button>
          </div>
        )}
      </div>

      {showExport && tab.database && results[resultIdx]?.sql && (
        <Suspense fallback={null}>
          <ExportDialog
            open={showExport}
            onClose={() => {
              setShowExport(false)
              setExportOverride(undefined)
            }}
            sessionId={tab.sessionId}
            database={tab.database}
            table="query_result"
            sql={results[resultIdx].sql}
            rowsOverride={exportOverride}
            rowsOverrideLabel="displayed rows"
          />
        </Suspense>
      )}
    </div>
  )
}

function TableTab({ tab }: Props) {
  const initialDataState = normalizeDataTabState(tab.dataState)
  const [view, setView] = useState<'schema' | 'data'>(initialDataState.view)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [initialLoading, setInitialLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [limit, setLimit] = useState(initialDataState.limit)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([])
  const [showDataExport, setShowDataExport] = useState(false)
  const [functions, setFunctions] = useState<string[]>([])
  const [exportOverride, setExportOverride] = useState<{ columns: string[], rows: unknown[][] } | undefined>()
  const [dataSortActive, setDataSortActive] = useState(false)
  const gridRef = useRef<ResultGridHandle>(null)
  const [showImport, setShowImport] = useState(false)
  const [globalSearch, setGlobalSearch] = useState(initialDataState.globalSearch)
  const [whereFilter, setWhereFilter] = useState(initialDataState.whereFilter)
  const [appliedWhere, setAppliedWhere] = useState(initialDataState.appliedWhere)
  const [showFilterBar, setShowFilterBar] = useState(initialDataState.showFilterBar)
  const [filterWordWrap, setFilterWordWrap] = useState(() => {
    const saved = localStorage.getItem(KEY_FILTER_WORD_WRAP)
    return saved !== null ? saved === 'true' : true
  })
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set())
  const [showColPicker, setShowColPicker] = useState(false)
  const [colSearch, setColSearch] = useState('')
  const [sortColsAlpha, setSortColsAlpha] = useState(false)
  const [pendingChanges, setPendingChanges] = useState<
    Map<string, { original: Record<string, unknown>; changes: Record<string, unknown> }>
  >(new Map())
  const [insertDrafts, setInsertDrafts] = useState<Map<string, Record<string, unknown>>>(new Map())
  const [insertDraftAnchors, setInsertDraftAnchors] = useState<Map<string, InsertDraftAnchor>>(new Map())
  const pendingChangesRef = useRef(pendingChanges)
  const insertDraftsRef = useRef(insertDrafts)
  useEffect(() => {
    pendingChangesRef.current = pendingChanges
    insertDraftsRef.current = insertDrafts
  })
  const loadAbortRef = useRef<AbortController | null>(null)
  const colPickerRef = useRef<HTMLDivElement>(null)
  const addEntry = useQueryLogStore(s => s.addEntry)
  const setTableDataState = useTabStore(s => s.setTableDataState)
  const { invalidateTablesForDb, loadTables } = useSchemaStore()

  const pkColumns = columns.filter(c => c.is_primary_key).map(c => c.name)
  const rowKeyColumns = pkColumns.length > 0 ? pkColumns : columns.map(c => c.name)

  const loadData = async (overrideLimit?: number, searchOverride?: string, whereOverride?: string, commitWhereOnSuccess?: string) => {
    if (!tab.database || !tab.table) return
    const effectiveLimit = overrideLimit ?? limit
    const effectiveSearch = searchOverride !== undefined ? searchOverride : globalSearch
    const effectiveWhere = whereOverride !== undefined ? whereOverride : appliedWhere

    // Cancel any in-flight load and start a fresh one
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller

    setSelectedRows([])

    if (result === null) {
      setInitialLoading(true)
    } else {
      setRefreshing(true)
    }

    const start = Date.now()
    try {
      // Fetch columns first so we can build LIKE conditions across all columns
      const cols = await api.getColumns(tab.sessionId, tab.database, tab.table, controller.signal)
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

      const res = await api.executeQuery(tab.sessionId, selectSql, undefined, effectiveLimit, controller.signal)
      if (shouldKeepPreviousResultOnLoad(res, result)) {
        setStatusMsg(`Filter error: ${res.error}`)
        setTimeout(() => setStatusMsg(null), 7000)
      } else {
        setResult(res)
        if (!res.error && commitWhereOnSuccess !== undefined) {
          setAppliedWhere(commitWhereOnSuccess)
        }
      }
      try { addEntry({ sql: selectSql, sessionId: tab.sessionId, database: tab.database, rowCount: res.row_count ?? undefined, execTimeMs: res.exec_time_ms ?? (Date.now() - start), error: res.error ?? undefined }) } catch { /* ignore */ }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setInitialLoading(false)
        setRefreshing(false)
        return
      }
      throw e
    } finally {
      if (loadAbortRef.current === controller) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }

  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData

  useEffect(() => {
    if (view === 'data' && !result) {
      loadData()
    }
  }, [view])

  useEffect(() => {
    const nextState = normalizeDataTabState(tab.dataState)
    setView(nextState.view)
    setResult(null)
    setColumns([])
    setGlobalSearch(nextState.globalSearch)
    setWhereFilter(nextState.whereFilter)
    setAppliedWhere(nextState.appliedWhere)
    setShowFilterBar(nextState.showFilterBar)
    setLimit(nextState.limit)
    setHiddenColumns(new Set())
    setShowColPicker(false)
    setColSearch('')
    setPendingChanges(new Map())
    setInsertDrafts(new Map())
    setInsertDraftAnchors(new Map())
  }, [tab.id, tab.sessionId, tab.database, tab.table])

  useEffect(() => {
    setTableDataState(tab.id, { view })
  }, [tab.id, view, setTableDataState])

  useEffect(() => {
    setTableDataState(tab.id, { globalSearch })
  }, [tab.id, globalSearch, setTableDataState])

  useEffect(() => {
    setTableDataState(tab.id, { whereFilter })
  }, [tab.id, whereFilter, setTableDataState])

  useEffect(() => {
    setTableDataState(tab.id, { appliedWhere })
  }, [tab.id, appliedWhere, setTableDataState])

  useEffect(() => {
    setTableDataState(tab.id, { showFilterBar })
  }, [tab.id, showFilterBar, setTableDataState])

  useEffect(() => {
    setTableDataState(tab.id, { limit })
  }, [tab.id, limit, setTableDataState])

  useEffect(() => {
    if (!showColPicker) return
    const handler = (e: MouseEvent) => {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) {
        setShowColPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColPicker])

  const appliedWhereRef = useRef(appliedWhere)
  appliedWhereRef.current = appliedWhere

  // Debounced global search — re-queries server on every keystroke pause
  useEffect(() => {
    if (view !== 'data') return
    const timer = setTimeout(() => {
      loadDataRef.current(undefined, globalSearch, appliedWhereRef.current)
    }, 400)
    return () => clearTimeout(timer)
  }, [globalSearch, view])

  // Load user-defined functions for autocomplete in the filter bar
  useEffect(() => {
    if (!tab.database) return
    api.getFunctions(tab.sessionId, tab.database)
      .then(setFunctions)
      .catch(() => setFunctions([]))
  }, [tab.sessionId, tab.database])

  const handleCellEdit = useCallback((params: { column: string; newValue: unknown; oldValue: unknown; data: Record<string, unknown> }) => {
    if (!tab.database || !tab.table || rowKeyColumns.length === 0) return
    if (initialLoading || refreshing) return
    const rowId = params.data.__ag_rowId as string

    if (params.data.__lagun_insertDraft) {
      setInsertDrafts(prev => {
        const next = new Map(prev)
        const draft = { ...(next.get(rowId) ?? {}) }
        draft[params.column] = params.newValue
        next.set(rowId, draft)
        insertDraftsRef.current = next
        return next
      })
      return
    }

    setPendingChanges(prev => {
      const next = new Map(prev)
      const existing = next.get(rowId)
      if (!existing) {
        // First edit on this row: reconstruct original by substituting oldValue for the edited cell
        const original: Record<string, unknown> = { ...params.data, [params.column]: params.oldValue }
        next.set(rowId, { original, changes: { [params.column]: params.newValue } })
      } else {
        const newChanges = { ...existing.changes, [params.column]: params.newValue }
        // If value reverted to original, drop that key
        if (params.newValue === existing.original[params.column]) {
          delete newChanges[params.column]
        }
        if (Object.keys(newChanges).length === 0) {
          next.delete(rowId)
        } else {
          next.set(rowId, { ...existing, changes: newChanges })
        }
      }
      pendingChangesRef.current = next
      return next
    })
  }, [tab.database, tab.table, rowKeyColumns, initialLoading, refreshing])

  const handleDuplicateRow = useCallback((row: Record<string, unknown>) => {
    const draftId = `__insert__${Date.now()}_${Math.random().toString(36).slice(2)}`
    const values: Record<string, unknown> = {}
    columns.forEach(col => {
      values[col.name] = row[col.name] ?? null
    })
    setInsertDrafts(prev => {
      const next = new Map(prev)
      next.set(draftId, values)
      insertDraftsRef.current = next
      return next
    })
    setInsertDraftAnchors(prev => {
      const next = new Map(prev)
      next.set(draftId, { afterRowId: row.__ag_rowId as string })
      return next
    })
    setStatusMsg('Duplicated row as an insert draft. Edit values, then Apply.')
    setTimeout(() => setStatusMsg(null), 4000)
  }, [columns])

  const handleApplyChanges = async () => {
    // Force-commit any in-progress cell edit before reading pending changes.
    // Without this, a just-edited cell whose blur hasn't fired yet would be
    // missing from pendingChanges — the WHERE clause would work correctly
    // (using old values) but the edit wouldn't be sent at all.
    gridRef.current?.stopEditing()
    await new Promise(resolve => setTimeout(resolve, 0))

    const currentPending = pendingChangesRef.current
    const currentDrafts = insertDraftsRef.current
    if (!tab.database || !tab.table || (currentPending.size === 0 && currentDrafts.size === 0)) return
    for (const [, { original, changes }] of currentPending) {
      const primary_key: Record<string, unknown> = {}
      rowKeyColumns.forEach(pk => { primary_key[pk] = original[pk] })
      const start = Date.now()
      const r = await api.rowUpdate(tab.sessionId, {
        database: tab.database,
        table: tab.table,
        primary_key,
        updates: changes,
      })
try { addEntry({ sql: r.sql_executed || `UPDATE ${tab.database}.${tab.table}`, sessionId: tab.sessionId, database: tab.database, affectedRows: r.affected_rows ?? undefined, execTimeMs: Date.now() - start, error: r.error ?? undefined }) } catch { /* ignore */ }
      if (!r.ok) {
        setStatusMsg(`✗ ${r.error}`)
        setTimeout(() => setStatusMsg(null), 4000)
        return
      }
      if (r.affected_rows === 0) {
        setStatusMsg(`✗ Update matched 0 rows — the row may have been modified or deleted since it was loaded.`)
        setTimeout(() => setStatusMsg(null), 6000)
        return
      }
    }
    for (const [, values] of currentDrafts) {
      const start = Date.now()
      const r = await api.rowInsert(tab.sessionId, {
        database: tab.database,
        table: tab.table,
        values,
      })
      try { addEntry({ sql: `INSERT INTO \`${tab.database}\`.\`${tab.table}\``, sessionId: tab.sessionId, database: tab.database, affectedRows: r.ok ? 1 : 0, execTimeMs: Date.now() - start, error: r.error ?? undefined }) } catch { /* ignore */ }
      if (!r.ok) {
        setStatusMsg(`✗ ${r.error}`)
        setTimeout(() => setStatusMsg(null), 4000)
        return
      }
    }
    setPendingChanges(new Map())
    setInsertDrafts(new Map())
    setInsertDraftAnchors(new Map())
    if (currentDrafts.size > 0) {
      setStatusMsg(`✓ Inserted ${currentDrafts.size} duplicated row${currentDrafts.size !== 1 ? 's' : ''}`)
      setTimeout(() => setStatusMsg(null), 4000)
    }

    // Optimistically apply changes to local result state
    if (currentPending.size > 0) {
      setResult(prev => {
        if (!prev) return prev
        const keyCols = rowKeyColumns.length > 0 ? rowKeyColumns : prev.columns
        const newRows = prev.rows.map((row, rowIdx) => {
          const rowObj: Record<string, unknown> = {}
          prev.columns.forEach((col, colIdx) => { rowObj[col] = row[colIdx] })
          const rowId = buildResultGridRowId(rowObj, rowIdx, keyCols, pkColumns.length === 0)
          const edit = currentPending.get(rowId)
          if (!edit) return row
          const updatedRow = [...row]
          for (const [col, newValue] of Object.entries(edit.changes)) {
            const colIndex = prev.columns.indexOf(col)
            if (colIndex >= 0) updatedRow[colIndex] = newValue
          }
          return updatedRow
        })
        return { ...prev, rows: newRows }
      })
    }

    invalidateTablesForDb(tab.sessionId!, tab.database!)
    loadTables(tab.sessionId!, tab.database!)
    loadData()
  }

  const handleDiscardChanges = () => {
    setPendingChanges(new Map())
    setInsertDrafts(new Map())
    loadData()
  }

  const handleDeleteRows = async (rows: Record<string, unknown>[]) => {
    if (!tab.database || !tab.table || rowKeyColumns.length === 0) return
    const primary_keys = rows.map(row => Object.fromEntries(rowKeyColumns.map(pk => [pk, row[pk]])))
    const r = await api.rowDelete(tab.sessionId, {
      database: tab.database,
      table: tab.table,
      primary_keys,
    })
    if (r.ok) {
      // Optimistically remove deleted rows from the local result state
      setResult(prev => {
        if (!prev) return prev
        // Build a set of deleted row keys for O(1) lookup
        const deletedKeys = new Set(
          rows.map(row => rowKeyColumns.map(pk => String(row[pk])).join('\x00'))
        )
        // Filter out deleted rows using column index lookup
        const newRows = prev.rows.filter(row => {
          const key = rowKeyColumns.map(pk => {
            const colIndex = prev.columns.indexOf(pk)
            return String(row[colIndex])
          }).join('\x00')
          return !deletedKeys.has(key)
        })
        return { ...prev, rows: newRows, row_count: newRows.length }
      })

      // Clear selected rows for deleted items (both React state and AG Grid internal selection)
      setSelectedRows(prev => {
        const deletedKeys = new Set(
          rows.map(row => rowKeyColumns.map(pk => String(row[pk])).join('\x00'))
        )
        return prev.filter(row => {
          const key = rowKeyColumns.map(pk => String(row[pk])).join('\x00')
          return !deletedKeys.has(key)
        })
      })
      gridRef.current?.deselectAll()

      setStatusMsg(`✓ Deleted ${r.affected_rows} row${r.affected_rows !== 1 ? 's' : ''}`)
      try { addEntry({ sql: `DELETE FROM \`${tab.database}\`.\`${tab.table}\` (${r.affected_rows} row${r.affected_rows !== 1 ? 's' : ''})`, sessionId: tab.sessionId, database: tab.database, affectedRows: r.affected_rows, execTimeMs: 0 }) } catch { /* ignore */ }
      invalidateTablesForDb(tab.sessionId!, tab.database!)
      loadTables(tab.sessionId!, tab.database!)
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
    loadDataRef.current(undefined, globalSearch, whereFilter, whereFilter)
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

  const handleFilterWordWrapChange = useCallback(() => {
    setFilterWordWrap(wrap => {
      const next = !wrap
      localStorage.setItem(KEY_FILTER_WORD_WRAP, String(next))
      return next
    })
  }, [])

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

  // Function completions for the filter bar (both built-in and user-defined)
  const filterFunctionCompletionExtension = useMemo(() => {
    const udfOptions = functions.map(name => ({
      label: name,
      type: 'function' as const,
      apply: `${name}(`,
      boost: 80,
    }))
    return MySQL.language.data.of({
      autocomplete: (context: CompletionContext): CompletionResult | null => {
        const word = context.matchBefore(/\w+/)
        if (!word && !context.explicit) return null
        return {
          from: word ? word.from : context.pos,
          options: [...udfOptions, ...MYSQL_BUILTIN_OPTIONS],
          validFor: /^\w*$/,
        }
      },
    })
  }, [functions])

  const filterWrapExtension = useMemo(() => EditorView.lineWrapping, [])
  const filterKeymapExtension = useMemo(() =>
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { applyFilterRef.current(); return true } },
    ])),
  [])
  const filterExtensions = useMemo(
    () => filterWordWrap
      ? [filterSqlExtension, filterColumnCompletionExtension, filterFunctionCompletionExtension, filterWrapExtension, filterKeymapExtension]
      : [filterSqlExtension, filterColumnCompletionExtension, filterFunctionCompletionExtension, filterKeymapExtension],
    [
      filterWordWrap,
      filterSqlExtension,
      filterColumnCompletionExtension,
      filterFunctionCompletionExtension,
      filterWrapExtension,
      filterKeymapExtension,
    ]
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center flex-wrap gap-2 px-3 py-1.5 bg-surface-900 border-b border-surface-800">
        <span className="text-xs text-slate-400 min-w-0 truncate max-w-full">{tab.database}.{tab.table}</span>
        <div className="flex-1 min-w-4" />
        {/* Global search input — shown in data view */}
        {view === 'data' && (
          <div className="relative flex items-center min-w-40">
            <Search size={11} className="absolute left-2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              placeholder="Search all columns…"
              className="bg-surface-800 border border-surface-700 rounded pl-6 pr-6 py-0.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500 w-44 max-w-full"
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
        {/* Column visibility picker */}
        {view === 'data' && result && result.columns.length > 0 && (
          <div className="relative" ref={colPickerRef}>
            <button
              onClick={() => setShowColPicker(v => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${
                hiddenColumns.size > 0
                  ? 'text-brand-400 bg-brand-950 border border-brand-800'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Select visible columns"
            >
              <Eye size={11} />
              Columns{hiddenColumns.size > 0 ? ` (${result.columns.length - hiddenColumns.size}/${result.columns.length})` : ''}
            </button>
            {showColPicker && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-surface-900 border border-surface-700 rounded shadow-xl w-52 flex flex-col">
                <div className="px-2 pt-2 pb-1">
                  <input
                    type="text"
                    value={colSearch}
                    onChange={e => setColSearch(e.target.value)}
                    placeholder="Filter columns…"
                    autoFocus
                    className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-0.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
                <label className="flex items-center gap-2 px-3 py-1 hover:bg-surface-800 cursor-pointer border-b border-surface-700">
                  <input
                    type="checkbox"
                    checked={hiddenColumns.size === 0}
                    onChange={e => setHiddenColumns(e.target.checked ? new Set() : new Set(result.columns))}
                    className="accent-brand-500"
                  />
                  <span className="text-xs text-slate-200 font-semibold">All</span>
                </label>
                <div className="max-h-60 overflow-y-auto">
                  {(sortColsAlpha ? [...result.columns].sort() : result.columns)
                    .filter(col => !colSearch || col.toLowerCase().includes(colSearch.toLowerCase()))
                    .map(col => (
                      <label key={col} className="flex items-center gap-2 px-3 py-1 hover:bg-surface-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!hiddenColumns.has(col)}
                          onChange={e => {
                            setHiddenColumns(prev => {
                              const next = new Set(prev)
                              if (e.target.checked) next.delete(col)
                              else next.add(col)
                              return next
                            })
                          }}
                          className="accent-brand-500"
                        />
                        <span className="text-xs text-slate-300 font-mono truncate" title={col}>{col}</span>
                      </label>
                    ))}
                </div>
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-800 cursor-pointer border-t border-surface-700">
                  <input
                    type="checkbox"
                    checked={sortColsAlpha}
                    onChange={e => setSortColsAlpha(e.target.checked)}
                    className="accent-brand-500"
                  />
                  <span className="text-xs text-slate-400">Sort alphabetically</span>
                </label>
              </div>
            )}
          </div>
        )}
        {view === 'data' && result && !result.error && result.columns.length > 0 && (
          <button
            onClick={() => gridRef.current?.clearSort()}
            disabled={!dataSortActive}
            className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors disabled:cursor-default ${
              dataSortActive
                ? 'text-brand-400 bg-brand-950 border border-brand-800 hover:text-brand-300'
                : 'text-slate-500'
            }`}
            title="Clear data sorting"
          >
            <ArrowUpDown size={11} /> Clear Sort
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
        {/* Pending changes: Apply / Discard */}
        {view === 'data' && (pendingChanges.size > 0 || insertDrafts.size > 0) && (
          <>
            <button
              onClick={handleApplyChanges}
              className="flex items-center gap-1 px-2 py-0.5 text-xs bg-amber-700 hover:bg-amber-600 text-white rounded transition-colors"
            >
              Apply ({pendingChanges.size + insertDrafts.size})
            </button>
            <button
              onClick={handleDiscardChanges}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Discard
            </button>
          </>
        )}
        {/* Refreshing / loading badge + cancel */}
        {view === 'data' && (initialLoading || refreshing) && (
          <>
            <RefreshCw size={12} className="animate-spin text-slate-400" />
            <button
              onClick={() => loadAbortRef.current?.abort()}
              className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              title="Cancel loading"
            >
              <X size={10} /> Cancel
            </button>
          </>
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
              if (selectedRows.length === 0 && (gridRef.current?.isAnyFilterPresent() || hiddenColumns.size > 0)) {
                setExportOverride(gridRef.current?.getFilteredData())
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
          <Button variant="ghost" size="sm" onClick={() => { setPendingChanges(new Map()); setInsertDrafts(new Map()); loadData() }} title="Refresh" disabled={initialLoading || refreshing}>
            <RefreshCw size={12} className={initialLoading || refreshing ? 'animate-spin' : ''} />
          </Button>
        )}
      </div>

      {/* WHERE filter bar */}
      {view === 'data' && showFilterBar && (
        <div className="flex items-center flex-wrap gap-2 px-3 py-1.5 bg-surface-900 border-b border-surface-700">
          <span className="inline-flex h-7 items-center text-xs text-slate-500 font-mono shrink-0">WHERE</span>
          <div className="flex-1 min-w-[220px] rounded overflow-hidden border border-surface-700 focus-within:ring-1 focus-within:ring-brand-500">
            <ReactCodeMirror
              value={whereFilter}
              onChange={val => {
                setWhereFilter(val)
                if (!val.trim() && appliedWhere) {
                  setAppliedWhere('')
                  loadData(undefined, globalSearch, '')
                }
              }}
              extensions={filterExtensions}
              theme={oneDark}
              minHeight="28px"
              maxHeight="96px"
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
            <Button
              variant="icon"
              size="sm"
              onClick={handleFilterWordWrapChange}
              aria-pressed={filterWordWrap}
              aria-label="Toggle WHERE filter word wrap"
              title={filterWordWrap ? 'Disable WHERE filter word wrap' : 'Enable WHERE filter word wrap'}
            >
              <WrapText size={12} />
            </Button>
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-slate-500 bg-surface-800 border border-surface-700 rounded">
              {isMac ? '⌘↵' : 'Ctrl+↵'}
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
      <div className="flex-1 overflow-hidden min-h-0">
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
              editable={columns.length > 0 && !initialLoading && !refreshing}
              primaryKeyColumns={rowKeyColumns}
              includeRowIndexInId={pkColumns.length === 0}
              onCellEdit={handleCellEdit}
              onDeleteRows={handleDeleteRows}
              onDuplicateRow={handleDuplicateRow}
              selectable={true}
              onSelectionChange={setSelectedRows}
              columns={columns}
              hiddenColumns={hiddenColumns}
              pendingChanges={pendingChanges}
              insertDrafts={insertDrafts}
              insertDraftAnchors={insertDraftAnchors}
              onSortActiveChange={setDataSortActive}
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
          <p className="text-xs font-mono text-slate-400 break-all">{statusMsg}</p>
        </div>
      )}

      {view === 'data' && result && (
        <div className="flex items-center border-t border-surface-800">
          <div className="flex-1 min-w-0">
            <ResultToolbar result={result} running={false} />
          </div>
        </div>
      )}

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
