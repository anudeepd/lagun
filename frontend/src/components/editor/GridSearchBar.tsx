import { useEffect, useRef } from 'react'
import * as m from 'motion/react-m'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { exitTransition } from '../../motion/tokens'

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

// Same pop-out spring as the torrus terminal find bar — invoked less often
// than other modals, so the twitchier spring is appropriate.
const FIND_BAR_SPRING = { type: 'spring', stiffness: 520, damping: 26, mass: 0.6 } as const

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
      initial={{ opacity: 0, scale: 0.85, y: -12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, y: -12, transition: exitTransition }}
      transition={FIND_BAR_SPRING}
      className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-xl border border-surface-600 bg-surface-900/95 px-2 py-1.5 shadow-2xl ring-1 ring-brand-500/30 backdrop-blur"
      role="search"
      aria-label="Find in grid"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label="Find in grid"
        autoFocus
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
        className="h-7 w-44 rounded bg-surface-950 px-2 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-brand-500"
      />
      <span
        aria-live="polite"
        className={`whitespace-nowrap px-1 text-[10px] ${hasMatches ? 'text-slate-400' : 'text-amber-400'}`}
      >
        {hasMatches ? `${currentMatch} of ${matchCount}` : 'No matches'}
      </span>
      <button
        type="button"
        onClick={onPrev}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onNext}
        title="Next match (Enter)"
        aria-label="Next match"
        className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close find (Esc)"
        aria-label="Close find"
        className="rounded p-1 text-slate-400 hover:bg-surface-800 hover:text-slate-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </m.div>
  )
}