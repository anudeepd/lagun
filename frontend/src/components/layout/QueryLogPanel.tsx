import { useEffect, useId, useRef, useState } from 'react'
import Tooltip from '../ui/Tooltip'
import { Terminal, ChevronUp, Copy, CornerDownLeft, Ban } from 'lucide-react'
import { useQueryLogStore } from '../../store/queryLogStore'
import type { QueryLogEntry } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import { clipboardWrite } from '../../utils/clipboard'
import { formatRowCount } from '../../utils/formatRows'
import * as m from 'motion/react-m'
import { AnimatePresence } from 'motion/react'
import { exitTransition, motionDistance, motionDuration, motionEase, surfaceTransition } from '../../motion/tokens'

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
  if (entry.rowCount != null) return formatRowCount(entry.rowCount)
  return '—'
}

export default function QueryLogPanel() {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)

  // The body stays mounted so the height animation has something to animate,
  // but while collapsed it must not be reachable: `aria-hidden` alone leaves its
  // buttons in the tab order (an aria-hidden-focus violation).
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !expanded
  }, [expanded])
  const entries = useQueryLogStore(s => s.entries)
  const clearLog = useQueryLogStore(s => s.clearLog)
  const tabs = useTabStore(s => s.tabs)
  const activeTabId = useTabStore(s => s.activeTabId)
  const injectSqlToTab = useTabStore(s => s.injectSqlToTab)
  const openQueryTabWithSql = useTabStore(s => s.openQueryTabWithSql)
  const activeTab = tabs.find(t => t.id === activeTabId)
  const hasQueryTab = activeTab?.type === 'query'

  return (
    <m.div
      initial={false}
      animate={{ height: expanded ? 208 : 28 }}
      transition={{ duration: motionDuration.spatial, ease: motionEase.move }}
      className="flex-shrink-0 overflow-hidden border-t border-surface-800 bg-surface-950"
    >
      {/* Header bar — always visible */}
      <div className="flex items-center gap-2 pl-1 pr-3 h-7">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          <Terminal size={12} className="text-muted" aria-hidden="true" />
          <span className="text-xs text-slate-400 font-medium">Query Log</span>
          {entries.length > 0 && (
            <span className="text-xs bg-surface-800 text-slate-400 rounded px-1 py-0.5 leading-none">
              {entries.length}
            </span>
          )}
        </button>
        <AnimatePresence initial={false}>
        {expanded && entries.length > 0 && (
          <m.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, transition: surfaceTransition }}
            exit={{ opacity: 0, scale: 0.8, transition: exitTransition }}
            onClick={clearLog}
            aria-label="Clear query log"
            className="text-xs text-muted hover:text-slate-300 transition-colors px-1"
          >
            Clear
          </m.button>
        )}
        </AnimatePresence>
        <m.span aria-hidden="true" animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: motionDuration.micro }} className="text-muted">
          <ChevronUp size={12} />
        </m.span>
      </div>

      {/* Log table — visible when expanded */}
      <div
        id={bodyId}
        ref={bodyRef}
        className={`h-[180px] overflow-y-auto ${expanded ? '' : 'pointer-events-none'}`}
        aria-hidden={!expanded || undefined}
      >
        <AnimatePresence initial={false} mode="wait">
          {entries.length === 0 ? (
            <m.div
              key="empty-log"
              initial={{ opacity: 0, y: motionDistance.subtle }}
              animate={{ opacity: 1, y: 0, transition: surfaceTransition }}
              exit={{ opacity: 0, transition: exitTransition }}
              className="flex items-center justify-center h-full text-muted text-xs"
            >
              No queries logged yet
            </m.div>
          ) : (
            <m.div
              key="query-entries"
              initial={{ opacity: 0, y: -motionDistance.subtle }}
              animate={{ opacity: 1, y: 0, transition: surfaceTransition }}
              exit={{ opacity: 0, y: motionDistance.surface, scale: 0.98, transition: exitTransition }}
            >
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-surface-900">
                <tr className="text-muted">
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
                      <td className="px-2 py-0.5 text-muted tabular-nums whitespace-nowrap">{formatTime(entry.timestamp)}</td>
                      <td className="px-2 py-0.5 font-mono text-slate-300 w-full break-all">
                        {entry.bulk ? (
                          <span className="text-brand-400">
                            Bulk write script: {entry.bulk.statementCount.toLocaleString()} statements
                            {entry.bulk.operationCounts && (
                              <span className="text-muted ml-1">
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
                          <Tooltip label="Copy SQL">
                          <button
                            onClick={() => { if (replaySql) clipboardWrite(replaySql).catch(() => {}) }}
                            disabled={!canReplay}
                            title={canReplay ? 'Copy SQL' : 'Full write script unavailable after reload'}
                            aria-label="Copy SQL"
                            className="lagun-hit-target text-muted hover:text-slate-300 transition-colors disabled:opacity-40 disabled:hover:text-muted"
                          >
                            <Copy size={10} aria-hidden="true" />
                          </button>
                          </Tooltip>
                          <Tooltip label={hasQueryTab ? 'Load into editor' : 'Open in new query tab'}>
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
                            aria-label={hasQueryTab ? 'Load into editor' : 'Open in new query tab'}
                            className="lagun-hit-target text-muted hover:text-brand-400 transition-colors disabled:opacity-40 disabled:hover:text-muted"
                          >
                            <CornerDownLeft size={10} aria-hidden="true" />
                          </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </m.div>
  )
}
