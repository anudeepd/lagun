import { useMemo, useRef, type Ref } from 'react'
import ReactCodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { sql, MySQL, schemaCompletionSource } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { Play, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import Button from '../ui/Button'

const LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000]

interface Props {
  value: string
  onChange: (val: string) => void
  onRun: () => void
  running: boolean
  database?: string
  databases?: string[]
  onDatabaseChange?: (db: string) => void
  schema?: Record<string, string[]>
  limit?: number
  onLimitChange?: (limit: number) => void
  editorRef?: Ref<ReactCodeMirrorRef>
}

export default function QueryEditor({ value, onChange, onRun, running, database, databases, onDatabaseChange, schema, limit, onLimitChange, editorRef }: Props) {
  // Keep schema in a ref so the extension never needs to be recreated when columns load
  const schemaRef = useRef(schema ?? {})
  schemaRef.current = schema ?? {}

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
