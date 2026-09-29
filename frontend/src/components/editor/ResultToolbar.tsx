import { Clock, Hash, AlertCircle } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import type { QueryResult } from '../../types'
import { exitTransition, surfaceTransition } from '../../motion/tokens'
import { formatRowCount } from '../../utils/formatRows'

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
          className="flex min-h-7 items-center gap-4 bg-surface-900 px-3 py-1.5 text-xs"
        >
          {running ? (
            <span className="text-muted">Executing…</span>
          ) : result?.error ? (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle size={12} /> Error
            </span>
          ) : result ? (
            <>
              <span className="flex items-center gap-1 text-muted">
                <Hash size={12} />
                {formatRowCount(result.row_count)}
              </span>
              {result.affected_rows != null && <span className="text-muted">{result.affected_rows} affected</span>}
              <span className="flex items-center gap-1 text-muted"><Clock size={12} />{result.exec_time_ms}ms</span>
              {result.insert_id ? <span className="text-muted">insert_id={result.insert_id}</span> : null}
            </>
          ) : null}
        </m.div>
      )}
    </AnimatePresence>
  )
}
