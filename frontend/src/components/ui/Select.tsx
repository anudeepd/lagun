import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import * as m from 'motion/react-m'
import { surfaceTransition } from '../../motion/tokens'
import Label from './Label'

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

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Select({ label, error, className, containerClassName, compact = false, children, value, defaultValue, onChange, disabled, id, 'aria-label': ariaLabel }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [uncontrolledValue, setUncontrolledValue] = useState(String(defaultValue ?? ''))
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
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
  const enabledOptions = options.filter(option => !option.disabled)
  const selectedValue = value === undefined ? uncontrolledValue : String(value)
  const selected = options.find(option => option.value === selectedValue) ?? options[0]
  const isInsideDialog = rootRef.current?.closest('[role="dialog"]') !== null

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
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
      const width = Math.min(Math.max(rect.width, compact ? 96 : 128), window.innerWidth - 16)
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
      const top = rect.bottom + (compact ? 3 : 4)
      const maxHeight = Math.min(320, window.innerHeight - top - 8)
      setMenuPosition({ top: maxHeight < 120 ? Math.max(8, rect.top - Math.min(320, rect.top - 8)) : top, left, width })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, compact])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  const choose = (next: SelectOption) => {
    if (next.disabled) return
    if (value === undefined) setUncontrolledValue(next.value)
    onChange?.({ target: { value: next.value }, currentTarget: { value: next.value } } as ChangeEvent<HTMLSelectElement>)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || enabledOptions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const selectedIndex = enabledOptions.findIndex(option => option.value === selectedValue)
      setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex)
      setOpen(true)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(enabledOptions.length - 1)
      setOpen(true)
    }
  }

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Tab') {
      const dialog = triggerRef.current?.closest('[role="dialog"], [role="alertdialog"]')
      if (!dialog) return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey && index === 0) focusables[focusables.length - 1].focus()
      else if (!event.shiftKey && index === enabledOptions.length - 1) focusables[0].focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : event.key === 'End' ? enabledOptions.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabledOptions.length) % enabledOptions.length)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(enabledOptions[index])
    }
  }

  return (
    <div ref={rootRef} className={clsx('flex min-w-0 flex-col gap-1', containerClassName)}>
      {label && <Label htmlFor={controlId}>{label}</Label>}
      <m.button
        ref={triggerRef}
        id={controlId}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (disabled || enabledOptions.length === 0) return
          setActiveIndex(Math.max(0, enabledOptions.findIndex(option => option.value === selectedValue)))
          setOpen(current => !current)
        }}
        onKeyDown={handleTriggerKeyDown}
        whileHover={disabled ? undefined : { scale: 1.012 }}
        whileTap={disabled ? undefined : { scale: 0.985 }}
        transition={surfaceTransition}
        className={clsx(
          'lagun-interactive flex w-full items-center justify-between rounded-md border border-surface-700 bg-surface-800 text-left text-slate-100',
          compact ? 'gap-2 px-2 py-0.5 text-xs' : 'gap-3 px-3 py-1.5 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-brand-400 disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-red-500', className,
        )}
      >
        <span className="min-w-0 truncate">{selected?.label}</span>
        <m.span className="shrink-0" animate={{ rotate: open ? 180 : 0 }} transition={surfaceTransition}><ChevronDown size={compact ? 12 : 14} /></m.span>
      </m.button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {createPortal(
        open ? (
          <m.div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel ?? label}
            initial={{ opacity: 0, scale: 0.96, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={surfaceTransition}
            style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: 'min(320px, calc(100vh - 16px))' }}
            className={clsx(isInsideDialog ? 'z-critical' : 'z-popover', 'origin-top overflow-y-auto rounded-md border border-surface-700 bg-surface-800 p-1 shadow-xl')}
          >
            {enabledOptions.map((option, index) => (
              <button
                key={option.value}
                ref={node => { optionRefs.current[index] = node }}
                type="button"
                role="option"
                aria-selected={option.value === selectedValue}
                onKeyDown={event => handleOptionKeyDown(event, index)}
                onClick={() => choose(option)}
                className={clsx(
                  'flex w-full items-center justify-between gap-3 rounded px-2 text-left transition-colors',
                  compact ? 'py-1 text-xs' : 'py-1.5 text-sm',
                  option.value === selectedValue ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-surface-700 hover:text-white',
                )}
              >
                <span>{option.label}</span>
                <Check size={compact ? 11 : 13} className={option.value === selectedValue ? 'opacity-100' : 'opacity-0'} />
              </button>
            ))}
          </m.div>
        ) : null, document.body,
      )}
    </div>
  )
}
