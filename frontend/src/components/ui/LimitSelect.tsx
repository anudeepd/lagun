import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
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
      const width = Math.min(Math.max(rect.width, 96), window.innerWidth - 16)
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
      const below = rect.bottom + 4
      const maxHeight = Math.min(320, window.innerHeight - below - 8)
      const top = maxHeight < 120 ? Math.max(8, rect.top - Math.min(320, rect.top - 8)) : below
      setMenuPosition({ top, left, width })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  const select = (next: number) => {
    onChange(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const selectedIndex = options.findIndex(option => option === value)
      setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex)
      setOpen(true)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
      setOpen(true)
    }
  }

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(options[index])
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <m.button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          const selectedIndex = options.findIndex(option => option === value)
          setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex)
          setOpen(current => !current)
        }}
        onKeyDown={handleTriggerKeyDown}
        whileHover={{ scale: 1.025 }}
        whileTap={{ scale: 0.96 }}
        transition={surfaceTransition}
        className="flex min-w-[66px] items-center justify-between gap-2 rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-brand-400"
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
              style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: 'min(320px, calc(100vh - 16px))' }}
              className="z-popover origin-top overflow-y-auto rounded-md border border-surface-700 bg-surface-800 p-1 shadow-xl"
            >
              {options.map((option, index) => (
                <button
                  key={option}
                  ref={node => { optionRefs.current[index] = node }}
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  onKeyDown={event => handleOptionKeyDown(event, index)}
                  onClick={() => select(option)}
                  className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs transition-colors ${option === value ? 'bg-brand-700 text-white' : 'text-slate-300 hover:bg-surface-700 hover:text-white'}`}
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
