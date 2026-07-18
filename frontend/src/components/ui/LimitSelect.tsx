import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, surfaceTransition } from '../../motion/tokens'

interface LimitSelectProps {
  value?: number
  options: readonly number[]
  onChange: (value: number) => void
  ariaLabel?: string
}

export default function LimitSelect({ value, options, onChange, ariaLabel = 'Row limit' }: LimitSelectProps) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const positionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPosition({ top: rect.bottom + 4, left: rect.right - Math.max(rect.width, 96), width: Math.max(rect.width, 96) })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open])

  const select = (next: number) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <m.button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(current => !current)}
        whileHover={{ scale: 1.025 }}
        whileTap={{ scale: 0.96 }}
        transition={surfaceTransition}
        className="flex min-w-[66px] items-center justify-between gap-2 rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand-500"
      >
        <span>{value?.toLocaleString()}</span>
        <m.span animate={{ rotate: open ? 180 : 0 }} transition={surfaceTransition}>
          <ChevronDown size={12} />
        </m.span>
      </m.button>
      {createPortal(
        <AnimatePresence>
          {open && (
          <m.div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4 }}
            transition={open ? surfaceTransition : exitTransition}
            style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
            className="z-popover origin-top overflow-hidden rounded-md border border-surface-700 bg-surface-800 p-1 shadow-xl"
          >
            {options.map(option => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                onClick={() => select(option)}
                className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  option === value
                    ? 'bg-brand-700 text-white'
                    : 'text-slate-300 hover:bg-surface-700 hover:text-white'
                }`}
              >
                {option.toLocaleString()}
                <Check size={12} className={option === value ? 'opacity-100' : 'opacity-0'} />
              </button>
            ))}
          </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
