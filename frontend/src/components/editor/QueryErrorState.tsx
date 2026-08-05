import { useId, useState } from 'react'
import { Check, CircleAlert, Copy } from 'lucide-react'
import Button from '../ui/Button'
import { clipboardWrite } from '../../utils/clipboard'
import { parseQueryError } from './queryError'

interface QueryErrorStateProps {
  error: string
}

export default function QueryErrorState({ error }: QueryErrorStateProps) {
  const parsed = parseQueryError(error)
  const headingId = useId()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await clipboardWrite(parsed.raw)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      role="alert"
      aria-labelledby={headingId}
      className="m-3 rounded-lg border border-red-800 bg-red-950/50 p-4 text-red-100"
    >
      <div className="flex items-start gap-3">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-red-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={headingId} className="text-sm font-semibold text-red-100">Query failed</h3>
            {parsed.code && (
              <span className="rounded border border-red-800/80 bg-red-950 px-1.5 py-0.5 font-mono text-[11px] text-red-300">
                Database error {parsed.code}
              </span>
            )}
          </div>
          <p className="mt-2 break-words whitespace-pre-wrap font-mono text-xs leading-relaxed text-red-200">
            {parsed.message}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-red-200 hover:bg-red-900/60 hover:text-red-100"
          onClick={handleCopy}
          aria-label="Copy query error"
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {parsed.code === '1356' && (
        <p className="ml-7 mt-3 text-xs leading-relaxed text-red-300">
          This view references missing objects, or its definer/invoker lacks permission. Check the view definition and grants, then run the query again.
        </p>
      )}
      <details className="ml-7 mt-3 text-xs text-red-300">
        <summary className="cursor-pointer select-none hover:text-red-100">Technical details</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-red-900/80 bg-red-950/70 p-2 font-mono text-[11px] leading-relaxed text-red-300">
          {parsed.raw}
        </pre>
      </details>
    </section>
  )
}
