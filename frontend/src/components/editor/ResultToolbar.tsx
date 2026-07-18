import { Clock, Hash, AlertCircle } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import type { QueryResult } from '../../types'
import { exitTransition, surfaceTransition } from '../../motion/tokens'

interface Props {
  result: QueryResult | null
  running: boolean
}

export default function ResultToolbar({ result, running }: Props) {
  const state = running ? 'running' : result?.error ? 'error' : result ? 'success' : 'idle'

  return (
    <AnimatePresence initial={false} mode="sync">
      {state !== 'idle' && (
        <m.div
          key={state}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: surfaceTransition }}
          exit={{ opacity: 0, transition: exitTransition }}
          className="flex min-h-7 items-center gap-4 border-t border-surface-800 bg-surface-900 px-3 py-1.5 text-xs"
        >
          {running ? (
            <span className="text-slate-400">Executing…</span>
          ) : result?.error ? (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle size={11} /> Error
            </span>
          ) : result ? (
            <>
              <span className="flex items-center gap-1 text-slate-400">
                <Hash size={11} />
                {result.row_count.toLocaleString()} {result.row_count === 1 ? 'row' : 'rows'}
              </span>
              {result.affected_rows != null && <span className="text-slate-400">{result.affected_rows} affected</span>}
              <span className="flex items-center gap-1 text-slate-500"><Clock size={11} />{result.exec_time_ms}ms</span>
              {result.insert_id ? <span className="text-slate-500">insert_id={result.insert_id}</span> : null}
            </>
          ) : null}
        </m.div>
      )}
    </AnimatePresence>
  )
}
