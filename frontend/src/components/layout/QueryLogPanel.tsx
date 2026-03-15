import { useState } from 'react'
import { Terminal, ChevronUp, ChevronDown } from 'lucide-react'
import { useQueryLogStore } from '../../store/queryLogStore'
import type { QueryLogEntry } from '../../store/queryLogStore'

function formatTime(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function formatRows(entry: QueryLogEntry): string {
  if (entry.affectedRows != null) return `${entry.affectedRows} affected`
  if (entry.rowCount != null) return `${entry.rowCount} rows`
  return '—'
}

export default function QueryLogPanel() {
  const [expanded, setExpanded] = useState(false)
  const { entries, clearLog } = useQueryLogStore()

  return (
    <div className="flex-shrink-0 border-t border-surface-800 bg-surface-950">
      {/* Header bar — always visible */}
      <div className="flex items-center gap-2 px-3 h-7 cursor-pointer select-none" onClick={() => setExpanded(e => !e)}>
        <Terminal size={12} className="text-slate-500" />
        <span className="text-xs text-slate-400 font-medium">Query Log</span>
        {entries.length > 0 && (
          <span className="text-xs bg-surface-800 text-slate-400 rounded px-1 py-0.5 leading-none">
            {entries.length}
          </span>
        )}
        <div className="flex-1" />
        {expanded && entries.length > 0 && (
          <button
            onClick={e => { e.stopPropagation(); clearLog() }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-1"
          >
            Clear
          </button>
        )}
        {expanded ? (
          <ChevronDown size={12} className="text-slate-500" />
        ) : (
          <ChevronUp size={12} className="text-slate-500" />
        )}
      </div>

      {/* Log table — visible when expanded */}
      {expanded && (
        <div className="h-[180px] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-slate-600 text-xs">
              No queries logged yet
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-surface-900">
                <tr className="text-slate-500">
                  <th className="text-left px-2 py-1 font-medium w-16">Time</th>
                  <th className="text-left px-2 py-1 font-medium">SQL</th>
                  <th className="text-left px-2 py-1 font-medium w-24">Rows</th>
                  <th className="text-left px-2 py-1 font-medium w-16">ms</th>
                  <th className="text-left px-2 py-1 font-medium w-12">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr
                    key={entry.id}
                    className={`border-t border-surface-800 ${entry.error ? 'bg-red-950/30' : ''}`}
                  >
                    <td className="px-2 py-0.5 text-slate-500 tabular-nums">{formatTime(entry.timestamp)}</td>
                    <td
                      className="px-2 py-0.5 font-mono text-slate-300 max-w-0 w-full truncate"
                      title={entry.sql}
                    >
                      {entry.sql.length > 80 ? entry.sql.slice(0, 80) + '…' : entry.sql}
                    </td>
                    <td className="px-2 py-0.5 text-slate-400 tabular-nums">{formatRows(entry)}</td>
                    <td className="px-2 py-0.5 text-slate-400 tabular-nums">{entry.execTimeMs}</td>
                    <td className="px-2 py-0.5">
                      {entry.error ? (
                        <span className="text-red-400" title={entry.error}>✗</span>
                      ) : (
                        <span className="text-green-400">✓</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
