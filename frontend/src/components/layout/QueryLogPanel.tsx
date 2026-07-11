import { useState } from 'react'
import { Terminal, ChevronUp, ChevronDown, Copy, CornerDownLeft, Ban } from 'lucide-react'
import { useQueryLogStore } from '../../store/queryLogStore'
import type { QueryLogEntry } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import { clipboardWrite } from '../../utils/clipboard'

function formatTime(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function formatRows(entry: QueryLogEntry): string {
  if (entry.cancelled) return '—'
  if (entry.bulk) {
    const parts: string[] = []
    if (entry.bulk.rolledBack) parts.push('rolled back')
    if (entry.affectedRows != null) parts.push(`${entry.affectedRows} affected`)
    return parts.length > 0 ? parts.join(', ') : `${entry.bulk.statementCount} stmts`
  }
  if (entry.affectedRows != null) return `${entry.affectedRows} affected`
  if (entry.rowCount != null) return `${entry.rowCount} rows`
  return '—'
}

export default function QueryLogPanel() {
  const [expanded, setExpanded] = useState(false)
  const { entries, clearLog } = useQueryLogStore()
  const { tabs, activeTabId, injectSqlToTab, openQueryTabWithSql } = useTabStore()
  const activeTab = tabs.find(t => t.id === activeTabId)
  const hasQueryTab = activeTab?.type === 'query'

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
                  <th className="w-14" />
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => {
                  const replaySql = entry.bulk ? entry.bulk.fullSql : entry.sql
                  const canReplay = Boolean(replaySql)
                  return (
                    <tr
                      key={entry.id}
                      className={`border-t border-surface-800 ${entry.error ? 'bg-red-950/30' : entry.cancelled ? 'bg-amber-950/20' : ''}`}
                    >
                      <td className="px-2 py-0.5 text-slate-500 tabular-nums whitespace-nowrap">{formatTime(entry.timestamp)}</td>
                      <td className="px-2 py-0.5 font-mono text-slate-300 w-full break-all">
                        {entry.bulk ? (
                          <span className="text-brand-400">
                            Bulk write script: {entry.bulk.statementCount.toLocaleString()} statements
                            {entry.bulk.operationCounts && (
                              <span className="text-slate-500 ml-1">
                                ({Object.entries(entry.bulk.operationCounts).map(([op, n]) => `${n} ${op}`).join(', ')})
                              </span>
                            )}
                          </span>
                        ) : entry.sql}
                      </td>
                      <td className="px-2 py-0.5 text-slate-400 tabular-nums whitespace-nowrap">{formatRows(entry)}</td>
                      <td className="px-2 py-0.5 text-slate-400 tabular-nums whitespace-nowrap">{entry.execTimeMs}</td>
                      <td className="px-2 py-0.5 whitespace-nowrap">
                        {entry.error ? (
                          <span className="text-red-400" title={entry.error}>✗</span>
                        ) : entry.cancelled ? (
                          <span title="Cancelled"><Ban size={10} className="text-amber-500" /></span>
                        ) : (
                          <span className="text-green-400">✓</span>
                        )}
                      </td>
                      <td className="px-2 py-0.5 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => { if (replaySql) clipboardWrite(replaySql).catch(() => {}) }}
                            disabled={!canReplay}
                            title={canReplay ? 'Copy SQL' : 'Full write script unavailable after reload'}
                            className="p-0.5 text-slate-600 hover:text-slate-300 transition-colors disabled:opacity-40 disabled:hover:text-slate-600"
                          >
                            <Copy size={10} />
                          </button>
                          <button
                            onClick={() => {
                              if (!replaySql) return
                              if (hasQueryTab) {
                                injectSqlToTab(activeTabId!, replaySql, entry.database)
                              } else {
                                openQueryTabWithSql(entry.sessionId, replaySql, entry.database)
                              }
                            }}
                            disabled={!canReplay}
                            title={canReplay ? (hasQueryTab ? 'Load into editor' : 'Open in new query tab') : 'Full write script unavailable after reload'}
                            className="p-0.5 text-slate-600 hover:text-brand-400 transition-colors disabled:opacity-40 disabled:hover:text-slate-600"
                          >
                            <CornerDownLeft size={10} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
