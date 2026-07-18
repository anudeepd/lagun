import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, surfaceTransition } from '../../motion/tokens'

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple'> {
  label?: string
  error?: string
  containerClassName?: string
  compact?: boolean
}

interface SelectOption {
  value: string
  label: string
  disabled: boolean
}

export default function Select({ label, error, className, containerClassName, compact = false, children, value, defaultValue, onChange, disabled, id, 'aria-label': ariaLabel }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [uncontrolledValue, setUncontrolledValue] = useState(String(defaultValue ?? ''))
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const generatedId = useId()
  const controlId = id ?? generatedId
  const menuId = `${controlId}-menu`
  const options: SelectOption[] = Children.toArray(children).flatMap(child => {
    if (!isValidElement(child) || child.type !== 'option') return []
    const option = child as ReactElement<{ value?: string | number, disabled?: boolean, children?: ReactNode }>
    const optionLabel = Children.toArray(option.props.children).join('')
    return [{ value: String(option.props.value ?? optionLabel), label: optionLabel, disabled: Boolean(option.props.disabled) }]
  })
  const selectedValue = value === undefined ? uncontrolledValue : String(value)
  const selected = options.find(option => option.value === selectedValue) ?? options[0]

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const positionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPosition({ top: rect.bottom + (compact ? 3 : 4), left: rect.left, width: Math.max(rect.width, compact ? 96 : 128) })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, compact])

  const choose = (next: SelectOption) => {
    if (next.disabled) return
    if (value === undefined) setUncontrolledValue(next.value)
    onChange?.({ target: { value: next.value }, currentTarget: { value: next.value } } as ChangeEvent<HTMLSelectElement>)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={clsx('flex min-w-0 flex-col gap-1', containerClassName)}>
      {label && <label htmlFor={controlId} className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</label>}
      <m.button
        id={controlId}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(current => !current)}
        whileHover={disabled ? undefined : { scale: 1.012 }}
        whileTap={disabled ? undefined : { scale: 0.985 }}
        transition={surfaceTransition}
        className={clsx(
          'lagun-interactive flex w-full items-center justify-between rounded-md border border-surface-700 bg-surface-800 text-left text-slate-100',
          compact ? 'gap-2 px-2 py-0.5 text-xs' : 'gap-3 px-3 py-1.5 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-red-500', className,
        )}
      >
        <span className="min-w-0 truncate">{selected?.label}</span>
        <m.span className="shrink-0" animate={{ rotate: open ? 180 : 0 }} transition={surfaceTransition}><ChevronDown size={compact ? 12 : 14} /></m.span>
      </m.button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {createPortal(
        <AnimatePresence>
          {open && (
            <m.div
              ref={menuRef}
              id={menuId}
              role="listbox"
              aria-label={ariaLabel ?? label}
              initial={{ opacity: 0, scale: 0.96, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: -4 }}
              transition={open ? surfaceTransition : exitTransition}
              style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: 'min(320px, calc(100vh - 16px))' }}
              className="z-popover origin-top overflow-y-auto rounded-md border border-surface-700 bg-surface-800 p-1 shadow-xl"
            >
              {options.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  disabled={option.disabled}
                  aria-selected={option.value === selectedValue}
                  onClick={() => choose(option)}
                  className={clsx(
                    'flex w-full items-center justify-between gap-3 rounded px-2 text-left transition-colors',
                    compact ? 'py-1 text-xs' : 'py-1.5 text-sm',
                    option.value === selectedValue ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-surface-700 hover:text-white',
                    option.disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <span>{option.label}</span>
                  <Check size={compact ? 11 : 13} className={option.value === selectedValue ? 'opacity-100' : 'opacity-0'} />
                </button>
              ))}
            </m.div>
          )}
        </AnimatePresence>, document.body,
      )}
    </div>
  )
}
