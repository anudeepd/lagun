import { useMemo } from 'react'
import ReactCodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Loader2 } from 'lucide-react'
import Button from '../ui/Button'

const LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000]

interface Props {
  value: string
  onChange: (val: string) => void
  onRun: () => void
  running: boolean
  database?: string
  schema?: Record<string, string[]>
  limit?: number
  onLimitChange?: (limit: number) => void
}

export default function QueryEditor({ value, onChange, onRun, running, database, schema, limit, onLimitChange }: Props) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!running) onRun()
    }
  }

  const sqlExtension = useMemo(() => sql({
    dialect: MySQL,
    schema: schema ?? {},
    defaultSchema: database,
  }), [schema, database])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-900 border-b border-surface-800">
        <div className="flex items-center gap-2">
          {database && (
            <span className="text-xs text-slate-500 bg-surface-800 px-2 py-0.5 rounded">
              {database}
            </span>
          )}
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
      <div className="flex-1 overflow-hidden" onKeyDown={handleKeyDown}>
        <ReactCodeMirror
          value={value}
          onChange={onChange}
          extensions={[sqlExtension]}
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
