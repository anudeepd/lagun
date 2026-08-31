import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { History } from 'lucide-react'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'

interface FilterHistoryDropdownProps {
  history: string[]
  disabled?: boolean
  /** The currently applied WHERE filter, if any — marked in the list. */
  activeFilter?: string
  /** Applies the picked filter into the WHERE bar and loads with it. */
  onSelect: (filter: string) => void
}

/**
 * HeidiSQL-style recent-filters dropdown for the data tab WHERE bar.
 * The list portals to document.body so the filter bar's height-collapse
 * animation cannot clip it (same pattern as GridContextMenu).
 */
export default function FilterHistoryDropdown({ history, disabled, activeFilter, onSelect }: FilterHistoryDropdownProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0, width: 280 })

  useMenuKeyboard(menuRef, () => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || buttonRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const clamp = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      // Anchored to the editor wrapper (the button's next sibling) so the menu
      // reads as the input's combobox popup, not a floating context menu.
      const anchor = buttonRef.current?.nextElementSibling?.getBoundingClientRect() ?? rect
      const width = Math.max(280, Math.round(anchor.width))
      const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8)
      setPos({ left, top: rect.bottom + 4, width })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [open])

  const menu = createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          ref={menuRef}
          role="menu"
          aria-label="Recent filters"
          initial={{ opacity: 0, scale: 0.96, y: -motionDistance.subtle }}
          animate={{ opacity: 1, scale: 1, y: 0, transition: surfaceTransition }}
          exit={{ opacity: 0, scale: 0.96, y: -motionDistance.subtle, transition: exitTransition }}
          className="fixed z-popover max-h-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-surface-700 bg-surface-900 py-1 shadow-2xl"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          {history.map((filter, i) => (
            <button
              key={`${filter}-${i}`}
              role="menuitem"
              aria-current={filter === activeFilter || undefined}
              className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-surface-800 focus-visible:bg-surface-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                filter === activeFilter ? 'text-brand-400' : 'text-slate-300'
              }`}
              title={filter}
              onClick={() => {
                setOpen(false)
                onSelect(filter)
              }}
            >
              {filter}
            </button>
          ))}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={disabled || history.length === 0}
        aria-haspopup="menu"
        aria-expanded={open || undefined}
        aria-label="Recent filters"
        title={history.length === 0 ? 'No recent filters yet' : 'Recent filters'}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border transition-colors ${
          open
            ? 'border-brand-800 bg-brand-950 text-brand-400'
            : 'border-surface-700 text-slate-500 hover:bg-surface-800 hover:text-slate-300'
        } disabled:pointer-events-none disabled:opacity-40`}
      >
        <History size={13} />
      </button>
      {menu}
    </>
  )
}
