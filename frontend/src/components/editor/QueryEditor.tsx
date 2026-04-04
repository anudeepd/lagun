import { useMemo, useRef, type Ref } from 'react'
import ReactCodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { sql, MySQL, schemaCompletionSource } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { Play, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import Button from '../ui/Button'

// Common MySQL/MariaDB built-in functions
const MYSQL_BUILTINS = [
  'ABS', 'ACOS', 'ADDDATE', 'ADDTIME', 'AES_DECRYPT', 'AES_ENCRYPT',
  'ASCII', 'ASIN', 'ATAN', 'ATAN2', 'AVG',
  'BENCHMARK', 'BIN', 'BIT_AND', 'BIT_COUNT', 'BIT_LENGTH', 'BIT_OR', 'BIT_XOR',
  'CAST', 'CEIL', 'CEILING', 'CHAR', 'CHARACTER_LENGTH', 'CHARSET', 'COALESCE',
  'COERCIBILITY', 'COLLATION', 'COMPRESS', 'CONCAT', 'CONCAT_WS', 'CONNECTION_ID',
  'CONV', 'CONVERT', 'CONVERT_TZ', 'COS', 'COT', 'COUNT', 'CRC32', 'CURDATE',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURTIME',
  'DATABASE', 'DATE', 'DATE_ADD', 'DATE_FORMAT', 'DATE_SUB', 'DATEDIFF', 'DAY',
  'DAYNAME', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR', 'DEGREES',
  'ELT', 'EXP', 'EXPORT_SET', 'EXTRACT',
  'FIELD', 'FIND_IN_SET', 'FLOOR', 'FORMAT', 'FOUND_ROWS', 'FROM_BASE64',
  'FROM_DAYS', 'FROM_UNIXTIME',
  'GET_FORMAT', 'GET_LOCK', 'GREATEST', 'GROUP_CONCAT',
  'HEX', 'HOUR',
  'IF', 'IFNULL', 'INET_ATON', 'INET_NTOA', 'INET6_ATON', 'INET6_NTOA',
  'INSERT', 'INSTR', 'IS_FREE_LOCK', 'IS_IPV4', 'IS_IPV4_COMPAT', 'IS_IPV4_MAPPED',
  'IS_IPV6', 'IS_USED_LOCK', 'ISNULL',
  'JSON_ARRAY', 'JSON_ARRAYAGG', 'JSON_CONTAINS', 'JSON_CONTAINS_PATH',
  'JSON_DEPTH', 'JSON_EXTRACT', 'JSON_INSERT', 'JSON_KEYS', 'JSON_LENGTH',
  'JSON_MERGE_PATCH', 'JSON_MERGE_PRESERVE', 'JSON_OBJECT', 'JSON_OBJECTAGG',
  'JSON_OVERLAPS', 'JSON_PRETTY', 'JSON_QUOTE', 'JSON_REMOVE', 'JSON_REPLACE',
  'JSON_SEARCH', 'JSON_SET', 'JSON_TYPE', 'JSON_UNQUOTE', 'JSON_VALID', 'JSON_VALUE',
  'LAST_DAY', 'LAST_INSERT_ID', 'LCASE', 'LEAST', 'LEFT', 'LENGTH', 'LN',
  'LOAD_FILE', 'LOCATE', 'LOG', 'LOG10', 'LOG2', 'LOWER', 'LPAD', 'LTRIM',
  'MAKE_SET', 'MAKEDATE', 'MAKETIME', 'MAX', 'MD5',
  'MICROSECOND', 'MID', 'MIN', 'MINUTE', 'MOD', 'MONTH', 'MONTHNAME',
  'NOW', 'NULLIF',
  'OCT', 'OCTET_LENGTH', 'ORD',
  'PERIOD_ADD', 'PERIOD_DIFF', 'PI', 'POW', 'POWER',
  'QUARTER', 'QUOTE',
  'RADIANS', 'RAND', 'REGEXP_INSTR', 'REGEXP_LIKE', 'REGEXP_REPLACE',
  'REGEXP_SUBSTR', 'RELEASE_LOCK', 'REPEAT', 'REPLACE',
  'REVERSE', 'RIGHT', 'ROUND', 'ROW_COUNT', 'RPAD', 'RTRIM',
  'SCHEMA', 'SEC_TO_TIME', 'SECOND', 'SESSION_USER', 'SHA', 'SHA1', 'SHA2',
  'SIGN', 'SIN', 'SLEEP', 'SOUNDEX', 'SPACE', 'SQRT', 'STD', 'STDDEV',
  'STDDEV_POP', 'STDDEV_SAMP', 'STR_TO_DATE', 'STRCMP', 'SUBDATE', 'SUBSTR',
  'SUBSTRING', 'SUBSTRING_INDEX', 'SUBTIME', 'SUM', 'SYSDATE', 'SYSTEM_USER',
  'TAN', 'TIME', 'TIME_FORMAT', 'TIME_TO_SEC', 'TIMEDIFF', 'TIMESTAMP',
  'TIMESTAMPADD', 'TIMESTAMPDIFF', 'TO_BASE64', 'TO_DAYS', 'TO_SECONDS', 'TRIM',
  'TRUNCATE',
  'UCASE', 'UNCOMPRESS', 'UNCOMPRESSED_LENGTH', 'UNHEX', 'UNIX_TIMESTAMP',
  'UPPER', 'USER', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'UUID', 'UUID_SHORT',
  'VALUES', 'VAR_POP', 'VAR_SAMP', 'VARIANCE', 'VERSION',
  'WEEK', 'WEEKDAY', 'WEEKOFYEAR', 'WEIGHT_STRING',
  'YEAR', 'YEARWEEK',
]

const MYSQL_BUILTIN_OPTIONS = MYSQL_BUILTINS.map(name => ({
  label: name,
  type: 'function' as const,
  apply: `${name}(`,
  boost: 50,
}))

const LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000]

// SQL keywords to exclude from implicit alias detection and subquery column parsing
const SQL_KEYWORDS = new Set([
  'WHERE', 'ON', 'SET', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS',
  'JOIN', 'HAVING', 'GROUP', 'ORDER', 'LIMIT', 'UNION', 'AND', 'OR',
  'SELECT', 'AS', 'INTO', 'FROM', 'UPDATE', 'DELETE', 'INSERT',
  'VALUES', 'USING', 'BY', 'WITH', 'DISTINCT', 'ALL', 'FULL',
  'NATURAL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NOT', 'IN',
  'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'EXCEPT', 'INTERSECT',
])

// Extract the current SQL statement from the document at the given position
function extractStatementAt(doc: string, pos: number): string {
  let start = 0
  for (let i = pos - 1; i >= 0; i--) {
    if (doc[i] === ';') { start = i + 1; break }
  }
  return doc.slice(start)
}

// Parse a statement for in-scope tables (FROM/JOIN) and subquery aliases
function extractScopeInfo(sql: string): { realTables: string[], subqueryAliases: Map<string, string[]> } {
  const realTables: string[] = []

  // FROM/JOIN real tables
  for (const m of sql.matchAll(/(?:FROM|JOIN)\s+`?(?:\w+`?\.`?)?(\w+)`?/gi)) {
    realTables.push(m[1])
  }

  // Subquery aliases: (SELECT ...) [AS] alias
  const subqueryAliases = new Map<string, string[]>()
  for (const m of sql.matchAll(/\(\s*SELECT\s+([\s\S]+?)\)\s*(?:AS\s+)?(\w+)/gi)) {
    const selectList = m[1]
    const alias = m[2]
    // Parse SELECT list: each comma-separated item, take the last identifier (bare name or AS alias)
    const cols = selectList.split(',').map(item => {
      item = item.trim()
      const asMatch = item.match(/\bAS\s+(\w+)\s*$/i)
      if (asMatch) return asMatch[1]
      const lastIdent = item.match(/(\w+)\s*$/)
      return lastIdent ? lastIdent[1] : null
    }).filter((c): c is string => c !== null && !SQL_KEYWORDS.has(c.toUpperCase()))
    if (cols.length) subqueryAliases.set(alias, cols)
  }

  return { realTables: [...new Set(realTables)], subqueryAliases }
}

// Check if the cursor is in a context that expects column names (not table names)
function isInColumnContext(textBefore: string): boolean {
  // Skip if cursor is after a dot — schemaCompletionSource handles that
  if (/\.\w*$/.test(textBefore)) return false
  // Skip if immediately after a table-name context keyword
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:`?\w+`?\.`?)?\w*$/i.test(textBefore)) return false
  return true
}

interface Props {
  value: string
  onChange: (val: string) => void
  onRun: () => void
  running: boolean
  database?: string
  databases?: string[]
  onDatabaseChange?: (db: string) => void
  schema?: Record<string, string[]>
  functions?: string[]
  limit?: number
  onLimitChange?: (limit: number) => void
  onCancel?: () => void
  editorRef?: Ref<ReactCodeMirrorRef>
}

export default function QueryEditor({ value, onChange, onRun, running, database, databases, onDatabaseChange, schema, functions, limit, onLimitChange, onCancel, editorRef }: Props) {
  // Keep schema in a ref so the extension never needs to be recreated when columns load
  const schemaRef = useRef(schema ?? {})
  schemaRef.current = schema ?? {}

  // Keep UDFs in a ref for the same reason
  const functionsRef = useRef(functions ?? [])
  functionsRef.current = functions ?? []

  // Refs so the stable keymap extension always calls the latest values
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const runningRef = useRef(running)
  runningRef.current = running

  // Stable extension: only recreates when database changes, not on every schema update.
  // Schema completions read from the ref at completion time so they're always current.
  const sqlExtension = useMemo(() => [
    sql({ dialect: MySQL, defaultSchema: database }),
    MySQL.language.data.of({
      autocomplete: (ctx: Parameters<ReturnType<typeof schemaCompletionSource>>[0]) =>
        schemaCompletionSource({ dialect: MySQL, schema: schemaRef.current, defaultSchema: database })(ctx),
    }),
    MySQL.language.data.of({
      autocomplete: (ctx: CompletionContext): CompletionResult | null => {
        const word = ctx.matchBefore(/\w+/)
        if (!word && !ctx.explicit) return null
        const udfOptions = functionsRef.current.map(name => ({
          label: name,
          type: 'function' as const,
          apply: `${name}(`,
          boost: 80,
        }))
        return {
          from: word ? word.from : ctx.pos,
          options: [...udfOptions, ...MYSQL_BUILTIN_OPTIONS],
          validFor: /^\w*$/,
        }
      },
    }),
    MySQL.language.data.of({
      autocomplete: (ctx: CompletionContext): CompletionResult | null => {
        const doc = ctx.state.doc.toString()
        const textBefore = doc.slice(0, ctx.pos)

        if (!isInColumnContext(textBefore)) return null

        const stmt = extractStatementAt(doc, ctx.pos)
        const { realTables, subqueryAliases } = extractScopeInfo(stmt)

        // Build column → [source tables] map
        const columnSources = new Map<string, string[]>()

        for (const tbl of realTables) {
          for (const col of schemaRef.current[tbl] ?? []) {
            if (!columnSources.has(col)) columnSources.set(col, [])
            columnSources.get(col)!.push(tbl)
          }
        }
        for (const [alias, cols] of subqueryAliases) {
          for (const col of cols) {
            if (!columnSources.has(col)) columnSources.set(col, [])
            columnSources.get(col)!.push(alias)
          }
        }

        if (!columnSources.size) return null

        const word = ctx.matchBefore(/\w+/)
        if (!word && !ctx.explicit) return null

        const options: Completion[] = []
        for (const [col, sources] of columnSources) {
          if (sources.length === 1) {
            // Unique column — suggest bare name, annotate with source table as detail
            options.push({ label: col, type: 'property', detail: sources[0], boost: 30 })
          } else {
            // Ambiguous — suggest qualified `table.col` for each source
            for (const src of sources) {
              options.push({ label: `${src}.${col}`, type: 'property', boost: 25 })
            }
          }
        }

        return {
          from: word ? word.from : ctx.pos,
          options,
          validFor: /^[\w.]*$/,
        }
      },
    }),
  ], [database])

  // Prec.highest ensures this fires before any other CodeMirror keymap handlers,
  // so the selection is still intact when run() reads it.
  const runKeymap = useMemo(() => Prec.highest(keymap.of([{
    key: 'Ctrl-Enter',
    mac: 'Cmd-Enter',
    run: () => { if (!runningRef.current) onRunRef.current(); return true },
  }])), [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-900 border-b border-surface-800">
        <div className="flex items-center gap-2">
          {databases && databases.length > 0 ? (
            <select
              value={database ?? ''}
              onChange={e => onDatabaseChange?.(e.target.value)}
              className={clsx(
                'bg-surface-800 border rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500',
                database
                  ? 'border-surface-700 text-slate-300'
                  : 'border-amber-600 text-amber-400'
              )}
            >
              {!database && <option value="" disabled>Select database…</option>}
              {databases.map(db => <option key={db} value={db}>{db}</option>)}
            </select>
          ) : database ? (
            <span className="text-xs text-slate-500 bg-surface-800 px-2 py-0.5 rounded">
              {database}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onLimitChange && (
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <span>Limit</span>
              <select
                value={limit}
                onChange={e => onLimitChange(Number(e.target.value))}
                className="bg-surface-800 border border-surface-700 rounded px-1.5 py-0.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {LIMIT_OPTIONS.map(n => (
                  <option key={n} value={n}>{n.toLocaleString()}</option>
                ))}
              </select>
            </div>
          )}
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-slate-500 bg-surface-800 border border-surface-700 rounded">
            Ctrl+↵
          </kbd>
          {running && onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} title="Cancel query">
              <X size={12} />
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={onRun}
            disabled={running || !value.trim()}
            title="Run (Ctrl+Enter)"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <ReactCodeMirror
          ref={editorRef}
          value={value}
          onChange={onChange}
          extensions={[sqlExtension, EditorView.lineWrapping, runKeymap]}
          theme={oneDark}
          className="h-full text-sm"
          style={{ height: '100%' }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            autocompletion: true,
            foldGutter: true,
          }}
        />
      </div>
    </div>
  )
}
