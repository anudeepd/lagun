import { Clock, Hash, AlertCircle } from 'lucide-react'
import type { QueryResult } from '../../types'

interface Props {
  result: QueryResult | null
  running: boolean
}

export default function ResultToolbar({ result, running }: Props) {
  if (running) {
    return (
      <div className="flex items-center gap-3 px-3 py-1.5 bg-surface-900 border-t border-surface-800 text-xs text-slate-400">
        <span className="animate-pulse">Executing...</span>
      </div>
    )
  }
  if (!result) return null

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 bg-surface-900 border-t border-surface-800 text-xs">
      {result.error ? (
        <span className="flex items-center gap-1 text-red-400">
          <AlertCircle size={11} /> Error
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1 text-slate-400">
            <Hash size={11} />
            {result.row_count.toLocaleString()} {result.row_count === 1 ? 'row' : 'rows'}
          </span>
          {result.affected_rows != null && (
            <span className="text-slate-400">
              {result.affected_rows} affected
            </span>
          )}
          <span className="flex items-center gap-1 text-slate-500">
            <Clock size={11} />
            {result.exec_time_ms}ms
          </span>
          {result.insert_id ? (
            <span className="text-slate-500">insert_id={result.insert_id}</span>
          ) : null}
        </>
      )}
    </div>
  )
}
