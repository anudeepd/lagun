/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import type { Tab, QueryResult, ColumnInfo, DataTabState, ScriptQueryResult, ScriptQueryValidationResult } from '../../types'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import { useQueryLogStore } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'
import QueryEditor from './QueryEditor'
import type { DuplicateRowMode, InsertDraftAnchor, ResultGridHandle } from './ResultGrid'
import ResultToolbar from './ResultToolbar'
import { Download, Upload, Search, Filter, X, Eye, WrapText, ArrowUpDown } from 'lucide-react'
import Button from '../ui/Button'
import LimitSelect from '../ui/LimitSelect'
import RefreshIcon from '../ui/RefreshIcon'
import { LoadingState } from '../ui/Spinner'
import Modal from '../ui/Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import ReactCodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap, tooltips } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { LIMIT_OPTIONS, SQL_KW, MYSQL_BUILTIN_OPTIONS } from '../../constants/sql'
import { isMac } from '../../utils/platform'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'

const TableSchemaView = lazy(() => import('../table/TableSchemaView'))
const loadResultGrid = () => import('./ResultGrid')
const ResultGrid = lazy(loadResultGrid)
const ExportDialog = lazy(() => import('../table/ExportDialog'))
const ImportDialog = lazy(() => import('../table/ImportDialog'))
const BulkConfirmDialog = lazy(() => import('./BulkConfirmDialog'))
const BulkResultSummary = lazy(() => import('./BulkResultSummary'))

function buildResultGridRowId(
  row: Record<string, unknown>,
  rowIdx: number,
  keyColumns: string[],
  includeRowIndexInId = keyColumns.length === 0,
): string {
  const keyValues = keyColumns.map(column => String(row[column] ?? '')).join('\x00')
  return includeRowIndexInId ? `${keyValues}\x00${rowIdx}` : keyValues || String(rowIdx)
}

const KEY_WORD_WRAP = 'lagun-query-word-wrap'
const KEY_FILTER_WORD_WRAP = 'lagun-data-filter-word-wrap'
const KEY_EDITOR_HEIGHT = 'lagun-query-editor-height'
const configuredFastExecuteThreshold = Number(import.meta.env.VITE_LAGUN_BULK_WRITE_THRESHOLD ?? 25)
const FAST_EXECUTE_THRESHOLD = Number.isFinite(configuredFastExecuteThreshold) && configuredFastExecuteThreshold > 0
  ? Math.floor(configuredFastExecuteThreshold)
  : 25

interface ExecutedQueryResult {
  id: string
  result: QueryResult
  sql: string
  scriptResult?: ScriptQueryResult
}

interface QueryExportContext {
  sql: string
  rowsOverride?: { columns: string[], rows: unknown[][] }
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

export function splitStatements(sql: string): string[] {
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

export function formatScriptError(error: ScriptQueryResult['error'] | ScriptQueryValidationResult['error']): string {
  if (!error) return 'Large write script failed'
  return `${error.problem}\n${error.cause}\n${error.fix}`
}

function statementFirstToken(statement: string): string {
  const stripped = statement
    .replace(/^\s*(?:--[^\n]*\n\s*)+/g, '')
    .replace(/^\s*(?:#[^\n]*\n\s*)+/g, '')
    .replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/g, '')
  return stripped.trim().match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''
}

export function shouldTryFastExecute(statements: string[]): boolean {
  const writeCount = statements.filter(stmt => ['INSERT', 'UPDATE', 'DELETE'].includes(statementFirstToken(stmt))).length
  return writeCount >= FAST_EXECUTE_THRESHOLD
}

export function scriptResultToQueryResult(result: ScriptQueryResult): QueryResult {
  const rows: unknown[][] = [
    ['Statements executed', result.statements_executed],
    ['Affected rows', result.affected_rows],
    ['Elapsed', `${result.exec_time_ms} ms`],
    ['Transaction', result.error?.code === 'CANCELLED_ROLLED_BACK' ? 'Cancelled' : result.rolled_back ? 'Rolled back' : result.ok ? 'Committed' : 'Not committed'],
  ]
  if (result.failed_statement_index !== null && result.failed_statement_index !== undefined) {
    rows.push(['Failed statement', result.failed_statement_index + 1])
  }
  if (result.failed_statement_preview) rows.push(['Failed preview', result.failed_statement_preview])

  return {
    columns: ['Field', 'Value'],
    rows,
    row_count: rows.length,
    affected_rows: result.affected_rows,
    exec_time_ms: result.exec_time_ms,
    error: result.error ? formatScriptError(result.error) : undefined,
  }
}

export const shouldKeepPreviousResultOnLoad = (nextResult: QueryResult, currentResult: QueryResult | null): boolean => {
  return Boolean(nextResult.error && currentResult !== null)
}

export const normalizeDataTabState = (state?: DataTabState): Required<DataTabState> => {
  return {
    view: state?.view ?? 'schema',
    globalSearch: state?.globalSearch ?? '',
    whereFilter: state?.whereFilter ?? '',
    appliedWhere: state?.appliedWhere ?? '',
    showFilterBar: state?.showFilterBar ?? Boolean(state?.whereFilter || state?.appliedWhere),
    limit: state?.limit ?? 1000,
  }
}

export const shouldDebounceDataSearch = (
  previousSearch: string,
  nextSearch: string,
  view: 'schema' | 'data',
) => view === 'data' && previousSearch !== nextSearch

export const buildQueryResultExportData = (
  result: QueryResult | undefined,
  grid: Pick<ResultGridHandle, 'isAnyFilterPresent' | 'getFilteredData'> | null,
): { columns: string[], rows: unknown[][] } | undefined => {
  if (!result) return undefined
  if (grid?.isAnyFilterPresent()) {
    return grid.getFilteredData()
  }
  return { columns: result.columns, rows: result.rows }
}

export const buildQueryExportContext = (
  entry: ExecutedQueryResult | undefined,
  grid: Pick<ResultGridHandle, 'isAnyFilterPresent' | 'getFilteredData'> | null,
): QueryExportContext | null => {
  if (!entry) return null
  return {
    sql: entry.sql,
    rowsOverride: buildQueryResultExportData(entry.result, grid),
  }
}

export const buildTableDataExportData = (
  result: QueryResult | null,
  grid: Pick<ResultGridHandle, 'getFilteredData'> | null,
): { columns: string[], rows: unknown[][] } | undefined => {
  if (!result || result.error) return undefined
  return grid?.getFilteredData() ?? { columns: result.columns, rows: result.rows }
}

export const buildSelectedRowsExportData = (
  result: QueryResult | null,
  rows: Record<string, unknown>[],
): { columns: string[], rows: unknown[][] } | undefined => {
  if (!result || result.error || rows.length === 0) return undefined
  return {
    columns: result.columns,
    rows: rows.map(row => result.columns.map(col => row[col] ?? null)),
  }
}

function quoteDataTabIdent(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

export const buildTableDataSelectSql = (
  database: string,
  table: string,
  columns: ColumnInfo[],
  globalSearch: string,
  whereFilter: string,
): string => {
  let selectSql = `SELECT * FROM ${quoteDataTabIdent(database)}.${quoteDataTabIdent(table)}`
  const conditions: string[] = []

  if (globalSearch.trim() && columns.length > 0) {
    const escaped = globalSearch.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')
    const likeParts = columns.map(c => `${quoteDataTabIdent(c.name)} LIKE '%${escaped}%'`)
    conditions.push(`(${likeParts.join(' OR ')})`)
  }

  if (whereFilter.trim()) {
    conditions.push(`(${whereFilter.trim()})`)
  }

  if (conditions.length > 0) {
    selectSql += ` WHERE ${conditions.join(' AND ')}`
  }

  const orderColumns = columns.filter(c => c.is_primary_key).map(c => c.name)
  if (orderColumns.length > 0) {
    selectSql += ` ORDER BY ${orderColumns.map(quoteDataTabIdent).join(', ')}`
  }

  return selectSql
}

export const buildDuplicateRowDraftValues = (
  row: Record<string, unknown>,
  columns: ColumnInfo[],
  mode: DuplicateRowMode,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  columns.forEach(col => {
    if (mode === 'withoutKeys' && (col.is_primary_key || col.is_auto_increment)) return
    values[col.name] = row[col.name] ?? null
  })
  return values
}

export const buildEmptyRowDraftValues = (columns: ColumnInfo[]): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  columns.forEach(col => {
    if (col.is_auto_increment || col.column_default !== null) return
    if (col.is_nullable) values[col.name] = null
  })
  return values
}

const MIN_EDITOR_HEIGHT = 100
const MAX_EDITOR_HEIGHT_FRACTION = 0.7

interface DataExportContext {
  rowsOverride?: { columns: string[], rows: unknown[][] }
  rowsOverrideLabel?: string
}

function QueryTab({ tab }: Props) {
  const storeSql = useTabStore(s => s.tabs.find(t => t.id === tab.id)?.sql ?? '')
  const setSqlStore = useTabStore(s => s.setSql)
  const setTabDirty = useTabStore(s => s.setTabDirty)
  const [sql, setSql] = useState(storeSql)
  const sqlRef = useRef(sql)
  sqlRef.current = sql

  // Debounce sync to store (and thus localStorage) — 500ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setSqlStore(tab.id, sql)
      setTabDirty(tab.id, Boolean(sql.trim()))
    }, 500)
    return () => clearTimeout(timer)
  }, [sql, tab.id, setSqlStore, setTabDirty])

  // Flush on unmount so switching tabs doesn't lose the latest keystroke
  useEffect(() => {
    return () => {
      setSqlStore(tab.id, sqlRef.current)
      setTabDirty(tab.id, Boolean(sqlRef.current.trim()))
    }
  }, [tab.id, setSqlStore, setTabDirty])

  // Re-initialize local state when switching to a different tab's content
  // storeSql intentionally omitted — adding it would overwrite local edits on every debounce sync
  useEffect(() => { setSql(storeSql) }, [tab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [results, setResults] = useState<ExecutedQueryResult[]>([])
  const [resultIdx, setResultIdx] = useState(0)
  const [running, setRunning] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<{ validation: ScriptQueryValidationResult; sql: string; toRun: string } | null>(null)
  const [bulkStatements, setBulkStatements] = useState<string[]>([])
  const [bulkValidation, setBulkValidation] = useState<ScriptQueryValidationResult | null>(null)
  const [bulkCancelled, setBulkCancelled] = useState(false)
  const [limit, setLimit] = useState(1000)
  const [functions, setFunctions] = useState<string[]>([])
  const [queryExportContext, setQueryExportContext] = useState<QueryExportContext | null>(null)
  const [resultSortActive, setResultSortActive] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const activeScriptExecutionRef = useRef<string | null>(null)
  const cancellingRef = useRef(false)
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
  }, [pendingSql, consumePendingSql, setTabDatabase, tab.id])

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
  }, [tab.sessionId, loadDatabases])

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
  }, [tab.sessionId, tab.database, loadTables])

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
  }, [sql, tab.sessionId, tab.database, loadColumns])

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

  const bulkOperationCounts = useMemo(() => {
    const counts: Record<string, number> = { INSERT: 0, UPDATE: 0, DELETE: 0 }
    for (const stmt of bulkStatements) {
      const token = statementFirstToken(stmt)
      if (token in counts) counts[token] += 1
    }
    return bulkValidation?.operation_counts ?? counts
  }, [bulkStatements, bulkValidation])

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
    setBulkCancelled(false)
    setBulkStatements(statements)
    setBulkValidation(null)
    const newResults: ExecutedQueryResult[] = []
    const executionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      if (shouldTryFastExecute(statements)) {
        const controller = new AbortController()
        abortControllerRef.current = controller
        activeScriptExecutionRef.current = executionId
        const start = Date.now()
        const validation = await api.validateScriptQuery(
          tab.sessionId,
          { execution_id: executionId, sql: toRun, database: tab.database },
          controller.signal,
        )

        if (!validation.ok) {
          const result: QueryResult = {
            columns: ['Field', 'Value'],
            rows: [
              ['Status', 'Unsupported large write script'],
              ['Statement count', validation.statement_count],
              ['Rejected statement', validation.rejected_statement_index !== null && validation.rejected_statement_index !== undefined ? validation.rejected_statement_index + 1 : ''],
              ['Preview', validation.rejected_statement_preview ?? ''],
            ],
            row_count: 4,
            exec_time_ms: Date.now() - start,
            error: formatScriptError(validation.error),
          }
          newResults.push({ id: `${executionId}-bulk`, result, sql: toRun })
          try {
            addEntry({
              sql: toRun,
              sessionId: tab.sessionId,
              database: tab.database,
              execTimeMs: result.exec_time_ms,
              error: result.error,
            })
          } catch { /* ignore localStorage errors */ }
          return
        }

        setBulkValidation(validation)

        const updates = validation.operation_counts.UPDATE ?? 0
        const deletes = validation.operation_counts.DELETE ?? 0
        if (updates > 0 || deletes > 0) {
          setBulkConfirm({ validation, sql: toRun, toRun })
          return
        }

        // INSERT-only: execute without confirmation
        await executeBulkScript(executionId, toRun, statements, tab.database, tab.sessionId, controller.signal, start, newResults, validation.operation_counts)
        return
      }

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
      activeScriptExecutionRef.current = null
      if (!bulkConfirm) {
        setResults(newResults)
        setResultIdx(0)
      }
      setRunning(false)
    }
  }

  const executeBulkScript = async (
    executionId: string,
    toRun: string,
    statements: string[],
    database: string | undefined,
    sessionId: string,
    signal: AbortSignal,
    start: number,
    newResults: ExecutedQueryResult[],
    operationCounts: Record<string, number> = {},
  ) => {
    let scriptResult: ScriptQueryResult
    try {
      scriptResult = await api.executeScriptQuery(
        sessionId,
        { execution_id: executionId, sql: toRun, database },
        signal,
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setBulkCancelled(true)
        scriptResult = {
          ok: false,
          execution_id: executionId,
          statements_executed: 0,
          affected_rows: 0,
          exec_time_ms: Date.now() - start,
          rolled_back: true,
          error: {
            code: 'CANCELLED_ROLLED_BACK',
            problem: 'Large write script was cancelled.',
            cause: 'Lagun sent a cancel request for this execution.',
            fix: 'Check target rows before rerunning if the connection dropped during cancellation.',
            docs_url: '/docs/bulk-execution#cancellation',
          },
        }
      } else {
        scriptResult = {
          ok: false,
          execution_id: executionId,
          statements_executed: 0,
          affected_rows: 0,
          exec_time_ms: Date.now() - start,
          rolled_back: false,
          error: {
            code: 'OUTCOME_UNKNOWN',
            problem: 'Large write script outcome is unknown.',
            cause: (e as Error).message || 'The request failed before Lagun received a final commit or rollback response.',
            fix: 'Check the target rows before rerunning the script.',
            docs_url: '/docs/bulk-execution#outcome-unknown',
          },
        }
      }
    }
    const result = scriptResultToQueryResult(scriptResult)
    newResults.push({ id: `${executionId}-bulk`, result, sql: toRun, scriptResult })
    try {
      const previewSql = scriptResult.statements_executed > 0
        ? toRun.slice(0, 500) + (toRun.length > 500 ? '…' : '')
        : toRun
      addEntry({
        sql: previewSql,
        sessionId,
        database,
        affectedRows: scriptResult.affected_rows,
        execTimeMs: scriptResult.exec_time_ms,
        error: result.error,
        cancelled: scriptResult.error?.code === 'CANCELLED_ROLLED_BACK',
        bulk: {
          statementCount: scriptResult.error?.code === 'CANCELLED_ROLLED_BACK' ? statements.length : scriptResult.statements_executed,
          operationCounts,
          rolledBack: scriptResult.rolled_back,
          failedStatementIndex: scriptResult.failed_statement_index,
          fullSql: toRun,
        },
      })
    } catch { /* ignore localStorage errors */ }
  }

  const handleBulkConfirm = async () => {
    if (!bulkConfirm) return
    const { sql: toRun } = bulkConfirm
    setBulkConfirm(null)

    setRunning(true)
    setBulkCancelled(false)
    setBulkValidation(bulkConfirm.validation)
    const newResults: ExecutedQueryResult[] = []
    const executionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const controller = new AbortController()
      abortControllerRef.current = controller
      activeScriptExecutionRef.current = executionId
      const start = Date.now()
      const statements = splitStatements(toRun)
      await executeBulkScript(executionId, toRun, statements, tab.database, tab.sessionId, controller.signal, start, newResults, bulkConfirm.validation.operation_counts)
    } finally {
      abortControllerRef.current = null
      activeScriptExecutionRef.current = null
      setResults(newResults)
      setResultIdx(0)
      setRunning(false)
    }
  }

  const handleCancel = async () => {
    if (cancellingRef.current) return
    cancellingRef.current = true
    const executionId = activeScriptExecutionRef.current
    if (executionId) setBulkCancelled(true)
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activeScriptExecutionRef.current = null
    try {
      if (executionId) await api.killScriptQuery(tab.sessionId, executionId)
      else await api.killQuery(tab.sessionId)
    } catch { /* ignore */ }
    finally { cancellingRef.current = false }
  }

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
                className={`relative px-3 py-1 text-xs whitespace-nowrap border-r border-surface-800 transition-colors ${
                  resultIdx === i
                    ? 'bg-surface-950 text-slate-200'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-800'
                }`}
              >
                {resultIdx === i && <m.span layoutId={`active-result-${tab.id}`} className="absolute inset-x-0 top-0 h-0.5 bg-brand-500" transition={surfaceTransition} />}
                {entry.result.error
                  ? `✗ Result ${i + 1}`
                  : entry.result.columns.length > 0
                    ? `Result ${i + 1} (${entry.result.row_count} rows)`
                    : `Result ${i + 1} (${entry.result.affected_rows ?? 0} affected)`}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
          <AnimatePresence initial={false} mode="wait">
          {results.length > 0 ? (
            <m.div key={results[resultIdx].id} initial={{ opacity: 0, x: motionDistance.surface }} animate={{ opacity: 1, x: 0, transition: surfaceTransition }} exit={{ opacity: 0, x: -motionDistance.surface, transition: exitTransition }} className="h-full">
            {results[resultIdx].scriptResult ? (
              <div className="p-4 overflow-y-auto h-full">
                <Suspense fallback={null}>
                  <BulkResultSummary
                    result={results[resultIdx].scriptResult!}
                    statements={bulkStatements}
                  />
                </Suspense>
              </div>
            ) : (
              <Suspense fallback={<LoadingState label="Preparing results…" />}>
                <ResultGrid
                  key={results[resultIdx].id}
                  ref={gridRef}
                  result={results[resultIdx].result}
                  onSortActiveChange={setResultSortActive}
                />
              </Suspense>
            )}
            </m.div>
          ) : (
            <m.div key="no-results" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: surfaceTransition }} className="flex items-center justify-center h-full text-slate-600 text-sm">
              Press {isMac ? '⌘Enter' : 'Ctrl+Enter'} to run a query
            </m.div>
          )}
          </AnimatePresence>
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
                setQueryExportContext(buildQueryExportContext(results[resultIdx], gridRef.current))
              }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              title="Export result"
            >
              <Download size={11} /> Export
            </button>
          </div>
        )}
      </div>

      {queryExportContext && tab.database && (
        <Suspense fallback={null}>
          <ExportDialog
            open={true}
            onClose={() => setQueryExportContext(null)}
            sessionId={tab.sessionId}
            database={tab.database}
            table="query_result"
            sql={queryExportContext.sql}
            rowsOverride={queryExportContext.rowsOverride}
            rowsOverrideLabel="displayed rows"
          />
        </Suspense>
      )}

      {bulkConfirm && (
        <Suspense fallback={null}>
          <BulkConfirmDialog
            open={true}
            validation={bulkConfirm.validation}
            database={tab.database}
            statements={bulkStatements}
            onConfirm={handleBulkConfirm}
            onClose={() => { setBulkConfirm(null); setBulkStatements([]); setBulkValidation(null) }}
          />
        </Suspense>
      )}

      {(running || bulkConfirm || bulkValidation) && bulkStatements.length >= FAST_EXECUTE_THRESHOLD && results.length === 0 && (
        <div className="flex-shrink-0 bg-surface-900 border-t border-surface-800 px-3 py-1.5 text-xs text-slate-400">
          Large write script: {(bulkValidation?.statement_count ?? bulkStatements.length).toLocaleString()} statements
          <span className="ml-1">
            ({Object.entries(bulkOperationCounts).filter(([, n]) => n > 0).map(([op, n]) => `${n} ${op}`).join(', ')})
          </span>
          <span className="ml-1">Mode: one transaction.</span>
        </div>
      )}

      {running && bulkStatements.length >= FAST_EXECUTE_THRESHOLD && (
        <div className="flex-shrink-0 bg-brand-950 border-t border-brand-800/50 px-3 py-1.5 text-xs text-brand-300">
          {bulkCancelled ? 'Cancelling and rolling back...' : `Executing ${bulkStatements.length.toLocaleString()} statements in one transaction...`}
        </div>
      )}
    </div>
  )
}

function TableTab({ tab }: Props) {
  const initialDataState = normalizeDataTabState(tab.dataState)
  const [view, setView] = useState<'schema' | 'data'>(initialDataState.view)
  const [schemaVisited, setSchemaVisited] = useState(initialDataState.view === 'schema')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [initialLoading, setInitialLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [limit, setLimit] = useState(initialDataState.limit)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([])
  const [dataExportContext, setDataExportContext] = useState<DataExportContext | null>(null)
  const [functions, setFunctions] = useState<string[]>([])
  const [dataSortActive, setDataSortActive] = useState(false)
  const gridRef = useRef<ResultGridHandle>(null)
  const [showImport, setShowImport] = useState(false)
  const [showChangeReview, setShowChangeReview] = useState(false)
  const [deleteRowsTarget, setDeleteRowsTarget] = useState<Record<string, unknown>[] | null>(null)
  const [globalSearch, setGlobalSearch] = useState(initialDataState.globalSearch)
  const [searchFocused, setSearchFocused] = useState(false)
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
  const loadSeqRef = useRef(0)
  const colPickerRef = useRef<HTMLDivElement>(null)
  const addEntry = useQueryLogStore(s => s.addEntry)
  const setTableDataState = useTabStore(s => s.setTableDataState)
  const setTabDirty = useTabStore(s => s.setTabDirty)
  const { invalidateTablesForDb, loadTables } = useSchemaStore()

  const pkColumns = useMemo(() =>
    columns.filter(c => c.is_primary_key).map(c => c.name),
    [columns],
  )
  const rowKeyColumns = useMemo(() =>
    pkColumns.length > 0 ? pkColumns : columns.map(c => c.name),
    [columns, pkColumns],
  )

  const loadData = async (overrideLimit?: number, searchOverride?: string, whereOverride?: string, commitWhereOnSuccess?: string) => {
    if (!tab.database || !tab.table) return
    const effectiveLimit = overrideLimit ?? limit
    const effectiveSearch = searchOverride !== undefined ? searchOverride : globalSearch
    const effectiveWhere = whereOverride !== undefined ? whereOverride : appliedWhere

    // Cancel any in-flight load and start a fresh one
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const requestSeq = ++loadSeqRef.current
    const isCurrentRequest = () =>
      loadAbortRef.current === controller && loadSeqRef.current === requestSeq && !controller.signal.aborted

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
      if (!isCurrentRequest()) return
      setColumns(cols)

      const selectSql = buildTableDataSelectSql(tab.database, tab.table, cols, effectiveSearch, effectiveWhere)
      const res = await api.executeQuery(tab.sessionId, selectSql, undefined, effectiveLimit, controller.signal)
      if (!isCurrentRequest()) return
      if (shouldKeepPreviousResultOnLoad(res, result)) {
        setStatusMsg(`Refresh failed; showing previous result. ${res.error}`)
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
        return
      }
      setStatusMsg(result
        ? `Refresh failed; showing previous result. ${(e as Error).message}`
        : `Could not load data. ${(e as Error).message}`)
      setTimeout(() => setStatusMsg(null), 7000)
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
    // Start downloading the heavy grid while the user is still reading Schema.
    // By the time the first data request completes there should be no second
    // "Loading data grid" phase.
    void loadResultGrid()
  }, [])

  useEffect(() => {
    return () => {
      loadSeqRef.current += 1
      loadAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (view === 'data') {
      loadDataRef.current()
    } else {
      setSchemaVisited(true)
    }
    // result intentionally omitted — adding it would cause infinite reload on every data fetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setDataExportContext(null)
    // tab.dataState intentionally omitted — adding it would reset table state on every filter/limit change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.sessionId, tab.database, tab.table])

  useEffect(() => {
    setTabDirty(tab.id, pendingChanges.size > 0 || insertDrafts.size > 0)
  }, [tab.id, pendingChanges, insertDrafts, setTabDirty])

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
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowColPicker(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [showColPicker])

  const appliedWhereRef = useRef(appliedWhere)
  appliedWhereRef.current = appliedWhere
  const previousGlobalSearchRef = useRef(globalSearch)

  // Debounced global search — re-queries server on every keystroke pause
  useEffect(() => {
    const previousSearch = previousGlobalSearchRef.current
    previousGlobalSearchRef.current = globalSearch
    if (!shouldDebounceDataSearch(previousSearch, globalSearch, view)) return
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

  const handleDuplicateRow = useCallback((row: Record<string, unknown>, mode: DuplicateRowMode) => {
    const draftId = `__insert__${Date.now()}_${Math.random().toString(36).slice(2)}`
    const values = buildDuplicateRowDraftValues(row, columns, mode)
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
    const label = mode === 'withoutKeys' ? 'without keys' : 'with keys'
    setStatusMsg(`Duplicated row ${label} as an insert draft. Edit values, then Apply.`)
    setTimeout(() => setStatusMsg(null), 4000)
  }, [columns])

  const handleCreateEmptyRow = useCallback(() => {
    const draftId = `__insert__${Date.now()}_${Math.random().toString(36).slice(2)}`
    const values = buildEmptyRowDraftValues(columns)
    setInsertDrafts(prev => {
      const next = new Map(prev)
      next.set(draftId, values)
      insertDraftsRef.current = next
      return next
    })
    setStatusMsg('Inserted empty row draft. Edit values, then Apply.')
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
      try {
        addEntry({
          sql: r.sql_executed || `UPDATE ${tab.database}.${tab.table}`,
          sessionId: tab.sessionId,
          database: tab.database,
          affectedRows: r.affected_rows ?? undefined,
          execTimeMs: Date.now() - start,
          error: r.error ?? undefined,
        })
      } catch { /* ignore */ }
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
      try {
        addEntry({
          sql: r.sql_executed || `INSERT INTO \`${tab.database}\`.\`${tab.table}\``,
          sessionId: tab.sessionId,
          database: tab.database,
          affectedRows: r.affected_rows ?? (r.ok ? 1 : 0),
          execTimeMs: Date.now() - start,
          error: r.error ?? undefined,
        })
      } catch { /* ignore */ }
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
      setStatusMsg(`✓ Inserted ${currentDrafts.size} row${currentDrafts.size !== 1 ? 's' : ''}`)
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

  const confirmApplyChanges = async () => {
    setShowChangeReview(false)
    await handleApplyChanges()
  }

  const handleDiscardChanges = () => {
    setPendingChanges(new Map())
    setInsertDrafts(new Map())
    setInsertDraftAnchors(new Map())
    loadData()
  }

  const handleDeleteRows = async (rows: Record<string, unknown>[]) => {
    if (!tab.database || !tab.table || rowKeyColumns.length === 0) return
    const primary_keys = rows.map(row => Object.fromEntries(rowKeyColumns.map(pk => [pk, row[pk]])))
    let r: Awaited<ReturnType<typeof api.rowDelete>>
    try {
      r = await api.rowDelete(tab.sessionId, {
        database: tab.database,
        table: tab.table,
        primary_keys,
      })
    } catch (e) {
      setStatusMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setStatusMsg(null), 4000)
      return
    }
    if (r.ok) {
      if (r.affected_rows === 0) {
        setStatusMsg('✗ Delete matched 0 rows — the row may have changed since it was loaded.')
        try { addEntry({ sql: r.sql_executed || `DELETE FROM \`${tab.database}\`.\`${tab.table}\``, sessionId: tab.sessionId, database: tab.database, affectedRows: 0, execTimeMs: 0 }) } catch { /* ignore */ }
        loadData()
        setTimeout(() => setStatusMsg(null), 6000)
        return
      }

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
      try { addEntry({ sql: r.sql_executed || `DELETE FROM \`${tab.database}\`.\`${tab.table}\``, sessionId: tab.sessionId, database: tab.database, affectedRows: r.affected_rows, execTimeMs: 0 }) } catch { /* ignore */ }
      invalidateTablesForDb(tab.sessionId!, tab.database!)
      loadTables(tab.sessionId!, tab.database!)
      loadData()
    } else {
      setStatusMsg(`✗ ${r.error}`)
    }
    setTimeout(() => setStatusMsg(null), 4000)
  }

  const requestDeleteRows = (rows: Record<string, unknown>[]) => {
    setDeleteRowsTarget(rows)
  }

  const confirmDeleteRows = () => {
    if (!deleteRowsTarget) return
    const rows = deleteRowsTarget
    setDeleteRowsTarget(null)
    void handleDeleteRows(rows)
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

  const dismissWhereFilter = useCallback(() => {
    setShowFilterBar(false)
    if (!whereFilter && !appliedWhere) return
    setWhereFilter('')
    setAppliedWhere('')
    loadDataRef.current(undefined, globalSearch, '')
  }, [whereFilter, appliedWhere, globalSearch])

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
  const dismissFilterRef = useRef(dismissWhereFilter)
  dismissFilterRef.current = dismissWhereFilter

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
  const filterVerticalCenterExtension = useMemo(() => EditorView.theme({
    '&': { minHeight: '32px' },
    '.cm-scroller': { lineHeight: '20px' },
    '.cm-content': { padding: '6px 0', minHeight: '32px' },
    '.cm-line': { padding: '0 8px', lineHeight: '20px' },
    '.cm-placeholder': { lineHeight: '20px' },
  }), [])
  const filterTooltipExtensions = useMemo((): Extension[] =>
    typeof document === 'undefined' ? [] : [tooltips({ parent: document.body })],
  [])
  const filterKeymapExtension = useMemo(() =>
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { applyFilterRef.current(); return true } },
    ])),
  [])
  // Lowest precedence lets autocomplete consume Escape first when its menu is open.
  const filterEscapeExtension = useMemo(() =>
    Prec.lowest(keymap.of([
      { key: 'Escape', run: () => { dismissFilterRef.current(); return true } },
    ])),
  [])
  const filterExtensions = useMemo(
    () => filterWordWrap
      ? [filterSqlExtension, filterColumnCompletionExtension, filterFunctionCompletionExtension, filterWrapExtension, filterVerticalCenterExtension, filterKeymapExtension, filterEscapeExtension, filterTooltipExtensions]
      : [filterSqlExtension, filterColumnCompletionExtension, filterFunctionCompletionExtension, filterVerticalCenterExtension, filterKeymapExtension, filterEscapeExtension, filterTooltipExtensions],
    [
      filterWordWrap,
      filterSqlExtension,
      filterColumnCompletionExtension,
      filterFunctionCompletionExtension,
      filterWrapExtension,
      filterVerticalCenterExtension,
      filterKeymapExtension,
      filterEscapeExtension,
      filterTooltipExtensions,
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
          <m.div
            animate={searchFocused
              ? { y: -1, scale: 1.018, boxShadow: '0 7px 18px rgba(2, 6, 23, 0.28)' }
              : { y: 0, scale: 1, boxShadow: '0 0 0 rgba(2, 6, 23, 0)' }}
            transition={surfaceTransition}
            className="relative flex items-center min-w-40 rounded origin-center"
          >
            <span className="absolute left-2 z-10 pointer-events-none">
                <Search size={11} className={`${searchFocused ? 'text-brand-400 scale-112' : 'text-slate-500'} transition-colors duration-200`} />
            </span>
            <input
              type="text"
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                if (globalSearch) handleClearSearch()
                e.currentTarget.blur()
              }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search all columns…"
              className="bg-surface-800 border border-surface-700 rounded pl-6 pr-6 py-0.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500 w-44 max-w-full"
            />
            <AnimatePresence>
            {globalSearch && (
              <m.button
                initial={{ opacity: 0, scale: 0.65, rotate: -35 }}
                animate={{ opacity: 1, scale: 1, rotate: 0, transition: surfaceTransition }}
                exit={{ opacity: 0, scale: 0.65, rotate: 25, transition: exitTransition }}
                onClick={handleClearSearch}
                className="absolute right-1.5 text-slate-500 hover:text-slate-300"
                aria-label="Clear column search"
              >
                <X size={10} />
              </m.button>
            )}
            </AnimatePresence>
          </m.div>
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
            <AnimatePresence>
            {showColPicker && (
              <m.div initial={{ opacity: 0, y: -motionDistance.surface, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1, transition: surfaceTransition }} exit={{ opacity: 0, y: -motionDistance.subtle, scale: 0.94, transition: exitTransition }} className="absolute right-0 top-full z-popover mt-1 flex w-52 flex-col rounded border border-surface-700 bg-surface-900 shadow-xl">
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
              </m.div>
            )}
            </AnimatePresence>
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
          <m.div
            key={`data-limit-${limit}`}
            initial={{ scale: 0.94, y: 2 }}
            animate={{ scale: 1, y: 0 }}
            whileHover={{ scale: 1.025 }}
            whileTap={{ scale: 0.96 }}
            transition={surfaceTransition}
            className="flex items-center gap-1 text-xs text-slate-500 rounded"
          >
            <span>Limit</span>
            <LimitSelect value={limit} options={LIMIT_OPTIONS} onChange={handleLimitChange} />
          </m.div>
        )}
        {/* Pending changes: Apply / Discard */}
        {view === 'data' && (pendingChanges.size > 0 || insertDrafts.size > 0) && (
          <>
            <button
              onClick={() => setShowChangeReview(true)}
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
        {/* View toggle */}
        <div className="relative flex rounded overflow-hidden border border-surface-700 bg-surface-800">
          <button
            className={`relative z-10 px-2.5 py-0.5 text-xs transition-colors ${view === 'schema' ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}
            onClick={() => setView('schema')}
          >
            {view === 'schema' && <m.span layoutId={`table-view-${tab.id}`} className="absolute inset-0 -z-10 bg-brand-600" transition={surfaceTransition} />}
            Schema
          </button>
          <button
            className={`relative z-10 px-2.5 py-0.5 text-xs transition-colors ${view === 'data' ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}
            onClick={() => setView('data')}
          >
            {view === 'data' && <m.span layoutId={`table-view-${tab.id}`} className="absolute inset-0 -z-10 bg-brand-600" transition={surfaceTransition} />}
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
              if (selectedRows.length > 0) {
                setDataExportContext({
                  rowsOverride: buildSelectedRowsExportData(result, selectedRows),
                  rowsOverrideLabel: 'selected rows',
                })
                return
              }
              setDataExportContext({
                rowsOverride: buildTableDataExportData(result, gridRef.current),
              })
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            title="Export data"
          >
            <Download size={11} /> Export
          </button>
        )}
        {view === 'data' && (
          <button
            type="button"
            onClick={() => { setPendingChanges(new Map()); setInsertDrafts(new Map()); setInsertDraftAnchors(new Map()); loadData() }}
            title={refreshing ? 'Refreshing data' : 'Refresh data'}
            aria-label={refreshing ? 'Refreshing data' : 'Refresh data'}
            disabled={initialLoading || refreshing}
            className={`rounded p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-wait ${refreshing ? 'text-slate-400' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <RefreshIcon refreshing={refreshing} size={12} />
          </button>
        )}
      </div>

      {/* WHERE filter bar */}
      <AnimatePresence initial={false}>
      {view === 'data' && showFilterBar && (
        <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto', transition: surfaceTransition }} exit={{ opacity: 0, height: 0, transition: exitTransition }} className="overflow-hidden border-b border-surface-700 bg-surface-900">
        <div className="flex items-center flex-wrap gap-2 px-3 py-1.5">
          <span className="inline-flex h-[34px] self-start items-center text-xs leading-none text-slate-500 font-mono shrink-0">WHERE</span>
          <div className="flex-1 min-w-[220px] rounded overflow-visible border border-surface-700 focus-within:ring-1 focus-within:ring-brand-500">
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
              minHeight="32px"
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
        </m.div>
      )}
      </AnimatePresence>

      {/* Content */}
      <div className="relative flex-1 overflow-hidden min-h-0">
        {schemaVisited && tab.database && tab.table && (
          <div className={`absolute inset-0 ${view === 'schema' ? 'motion-safe:animate-[lagun-tab-content-in_var(--motion-duration-surface)_var(--motion-ease-move)]' : 'invisible pointer-events-none'}`} aria-hidden={view !== 'schema' || undefined}>
            <Suspense fallback={<LoadingState label={`Preparing schema for ${tab.table}…`} />}>
              <TableSchemaView
                sessionId={tab.sessionId}
                database={tab.database}
                table={tab.table}
              />
            </Suspense>
          </div>
        )}
        {view === 'data' && (
          <div className="absolute inset-0 motion-safe:animate-[lagun-tab-content-in_var(--motion-duration-surface)_var(--motion-ease-move)]">
          {
          initialLoading || refreshing ? (
            <LoadingState label={initialLoading ? `Loading rows from ${tab.table}…` : 'Searching…'} />
          ) : result ? (
          <Suspense fallback={<LoadingState label="Preparing data grid…" />}>
            <div className="relative h-full">
            <ResultGrid
                ref={gridRef}
                result={result}
                editable={columns.length > 0 && !initialLoading && !refreshing}
                primaryKeyColumns={rowKeyColumns}
                includeRowIndexInId={pkColumns.length === 0}
                onCellEdit={handleCellEdit}
                onDeleteRows={requestDeleteRows}
                onDuplicateRow={handleDuplicateRow}
                onCreateEmptyRow={handleCreateEmptyRow}
                selectable={true}
                onSelectionChange={setSelectedRows}
                columns={columns}
                hiddenColumns={hiddenColumns}
                pendingChanges={pendingChanges}
                insertDrafts={insertDrafts}
                insertDraftAnchors={insertDraftAnchors}
              onSortActiveChange={setDataSortActive}
            />
            </div>
          </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-600 motion-safe:animate-[lagun-fade-in_var(--motion-duration-surface)_ease-out]">
              No data loaded
            </div>
          )
          }
          </div>
        )}
      </div>

      {statusMsg && (
        <div className="border-t border-surface-800 bg-surface-900 px-3 py-1.5 motion-safe:animate-[lagun-fade-in_var(--motion-duration-surface)_ease-out]">
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

      {dataExportContext && tab.database && tab.table && (
        <Suspense fallback={null}>
          <ExportDialog
            open={true}
            onClose={() => setDataExportContext(null)}
            sessionId={tab.sessionId}
            database={tab.database}
            table={tab.table}
            rowsOverride={dataExportContext.rowsOverride}
            rowsOverrideLabel={dataExportContext.rowsOverrideLabel ?? 'displayed rows'}
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
      <ConfirmDialog
        open={deleteRowsTarget !== null}
        title={deleteRowsTarget?.length === 1 ? 'Delete Row' : 'Delete Rows'}
        message={deleteRowsTarget?.length === 1
          ? 'Delete this row permanently? This action cannot be undone.'
          : `Delete ${deleteRowsTarget?.length ?? 0} rows permanently? This action cannot be undone.`}
        confirmLabel={deleteRowsTarget?.length === 1 ? 'Delete Row' : 'Delete Rows'}
        danger
        onConfirm={confirmDeleteRows}
        onClose={() => setDeleteRowsTarget(null)}
      />
      <Modal
        open={showChangeReview}
        onClose={() => setShowChangeReview(false)}
        title="Review Staged Changes"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setShowChangeReview(false)}>Cancel</Button>
            <Button variant="primary" onClick={confirmApplyChanges}>Apply Changes</Button>
          </>
        )}
      >
        <div className="space-y-4 text-sm text-slate-300">
          <p>Changes run one row at a time. Lagun stops at first failed row; already applied rows remain changed.</p>
          <dl className="grid grid-cols-2 gap-2 rounded-md border border-surface-700 bg-surface-800 p-3 text-xs">
            <div><dt className="text-slate-500">Rows to update</dt><dd className="mt-1 font-mono text-slate-100">{pendingChanges.size}</dd></div>
            <div><dt className="text-slate-500">Rows to insert</dt><dd className="mt-1 font-mono text-slate-100">{insertDrafts.size}</dd></div>
          </dl>
          {pendingChanges.size > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Changed columns</p>
              <div className="flex flex-wrap gap-1.5">
                {[...new Set([...pendingChanges.values()].flatMap(change => Object.keys(change.changes)))].map(column => (
                  <span key={column} className="rounded border border-surface-700 bg-surface-800 px-2 py-1 font-mono text-xs text-slate-200">{column}</span>
                ))}
              </div>
            </div>
          )}
          <p className="rounded border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">Review complete before applying. This action cannot be automatically undone.</p>
        </div>
      </Modal>
    </div>
  )
}
