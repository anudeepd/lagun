import { useEffect, useRef } from 'react'
import { useIsPresent, useReducedMotion } from 'motion/react'
import * as m from 'motion/react-m'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { motionDuration, motionEase } from '../../motion/tokens'

interface GridSearchBarProps {
  open: boolean
  query: string
  matchCount: number
  currentMatch: number // 1-indexed for display ("3 of 12"), 0 if no matches
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}


export default function GridSearchBar({
  open,
  query,
  matchCount,
  currentMatch,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: GridSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const isPresent = useIsPresent()
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  const hasMatches = matchCount > 0

  return (
    <m.div
      ref={node => { if (node) node.inert = !isPresent }}
      initial={{ gridTemplateRows: reduceMotion ? '1fr' : '0fr', opacity: 0 }}
      animate={{ gridTemplateRows: '1fr', opacity: 1 }}
      exit={{ gridTemplateRows: reduceMotion ? '1fr' : '0fr', opacity: 0, transition: { duration: motionDuration.instant, ease: motionEase.exit } }}
      transition={{ duration: motionDuration.micro, ease: motionEase.move }}
      className="grid shrink-0"
      aria-hidden={!isPresent || undefined}
    >
      <div className="min-h-0 overflow-hidden">
      <div
      className="lagun-grid-find flex items-center gap-2 border-b border-surface-700 bg-surface-900 px-3 py-2"
      role="search"
      aria-label="Find in grid"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="hidden shrink-0 text-xs text-muted lg:inline">Find in results</span>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label="Find in grid"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          }
        }}
        placeholder="Find in grid"
        className="lagun-grid-find-input h-7 w-32 min-w-0 flex-1 rounded border border-surface-700 bg-surface-950 px-2 text-xs text-slate-200 placeholder:text-muted focus:outline-none focus:border-brand-400 sm:max-w-64"
      />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`min-w-[5.5rem] whitespace-nowrap text-right text-xs tabular-nums ${query && !hasMatches ? 'text-slate-300' : 'text-muted'}`}
      >
        {!query ? 'Type to find' : hasMatches ? `${currentMatch} of ${matchCount}` : 'No matches'}
      </span>
      <button
        type="button"
        onClick={onPrev}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={!hasMatches}
        className="lagun-find-button"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onNext}
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={!hasMatches}
        className="lagun-find-button"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <span className="mx-1 h-4 shrink-0 border-l border-surface-700" aria-hidden="true" />
      <button
        type="button"
        onClick={onClose}
        title="Close find (Esc)"
        aria-label="Close find"
        className="lagun-find-button"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      </div>
      </div>
    </m.div>
  )
}