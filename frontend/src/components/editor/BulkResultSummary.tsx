import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle, XCircle, Ban } from 'lucide-react'
import type { ScriptQueryResult } from '../../types'

interface BulkResultSummaryProps {
  result: ScriptQueryResult
  statements: string[]
}

function previewList(stmts: string[], indices: number[]): string[] {
  return indices
    .filter(i => i >= 0 && i < stmts.length)
    .slice(0, 3)
    .map(i => stmts[i].length > 160 ? stmts[i].slice(0, 160) + '…' : stmts[i])
}

export default function BulkResultSummary({ result, statements }: BulkResultSummaryProps) {
  const [expanded, setExpanded] = useState(false)

  const statusIcon = result.ok
    ? <CheckCircle size={14} className="text-green-400" />
    : result.rolled_back
      ? <XCircle size={14} className="text-red-400" />
      : <Ban size={14} className="text-amber-400" />

  const outcomeUnknown = result.error?.code === 'OUTCOME_UNKNOWN'
  const cancelled = result.error?.code === 'CANCELLED_ROLLED_BACK'

  const statusText = result.ok
    ? 'Committed'
    : cancelled
      ? 'Cancelled'
    : outcomeUnknown
      ? 'Outcome unknown'
      : result.rolled_back
        ? 'Rolled back'
        : 'Not committed'

  const statusColor = result.ok
    ? 'text-green-400'
    : cancelled
      ? 'text-amber-400'
    : outcomeUnknown
      ? 'text-amber-400'
      : result.rolled_back
      ? 'text-red-400'
      : 'text-amber-400'

  return (
    <div className="border border-surface-700 rounded-lg bg-surface-900 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        {statusIcon}
        <span className={`text-sm font-medium ${statusColor}`}>{statusText}</span>
        <span className="text-xs text-slate-500">
          {result.statements_executed.toLocaleString()} statements, {result.affected_rows.toLocaleString()} affected, {result.exec_time_ms}ms
        </span>
        <div className="flex-1" />
        {result.error && (
          <span className="text-xs text-red-400 truncate max-w-xs" title={result.error.fix}>
            {result.error.problem}
          </span>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Details
        </button>
      </div>

      {expanded && (
        <div className="border-t border-surface-700 px-4 py-3 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2 text-slate-400">
            <div>Mode: <span className="text-slate-200">one transaction</span></div>
            <div>Statements: <span className="text-slate-200">{result.statements_executed.toLocaleString()}</span></div>
            <div>Affected rows: <span className="text-slate-200">{result.affected_rows.toLocaleString()}</span></div>
            <div>Elapsed: <span className="text-slate-200">{result.exec_time_ms}ms</span></div>
            {result.failed_statement_index != null && (
              <div>Failed at: <span className="text-red-400">statement {(result.failed_statement_index ?? 0) + 1}</span></div>
            )}
            {result.rolled_back && (
              <div>Transaction: <span className="text-red-400">rolled back</span></div>
            )}
          </div>

          {result.failed_statement_preview && (
            <div>
              <div className="text-slate-500 mb-1">Failed statement:</div>
              <pre className="bg-surface-800 rounded p-2 text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                {result.failed_statement_preview}
              </pre>
            </div>
          )}

          {result.error && (
            <div className="bg-red-950/30 border border-red-800/30 rounded p-2 space-y-1">
              <div className="flex items-center gap-1 text-red-400 font-medium">
                <AlertTriangle size={12} />
                {result.error.code}
              </div>
              <div className="text-slate-400">{result.error.problem}</div>
              <div className="text-slate-500">{result.error.cause}</div>
              <div className="text-slate-400">{result.error.fix}</div>
            </div>
          )}

          {statements.length > 0 && (
            <div>
              <div className="text-slate-500 mb-1">First statements:</div>
              <div className="space-y-1">
                {previewList(statements, [0, 1, 2]).map((s, i) => (
                  <pre key={i} className="bg-surface-800 rounded p-2 text-slate-400 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all">
                    {i + 1}. {s}
                  </pre>
                ))}
              </div>
            </div>
          )}

          {(() => {
            const lastIndices = statements.length > 3 && result.statements_executed > 3
              ? [result.statements_executed - 3, result.statements_executed - 2, result.statements_executed - 1]
              : []
            const lastStmts = previewList(statements, lastIndices)
            return lastStmts.length > 0 && (
              <div>
                <div className="text-slate-500 mb-1">Last executed statements:</div>
                <div className="space-y-1">
                  {lastStmts.map((s, i) => (
                    <pre key={i} className="bg-surface-800 rounded p-2 text-slate-400 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all">
                      {result.statements_executed - 2 + i}. {s}
                    </pre>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
