import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

interface TooltipChildProps {
  onMouseEnter?: React.MouseEventHandler
  onMouseLeave?: React.MouseEventHandler
  onFocus?: React.FocusEventHandler
  onBlur?: React.FocusEventHandler
  onKeyDown?: React.KeyboardEventHandler
  'aria-describedby'?: string
}

interface Props {
  label: string
  children: ReactElement<TooltipChildProps>
  side?: 'top' | 'bottom'
  portal?: boolean
}

export default function Tooltip({ label, children, side = 'top', portal = false }: Props) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const id = useId()

  useLayoutEffect(() => {
    if (!open || !portal || !wrapperRef.current) return
    const updatePosition = () => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return
      const tooltipRect = tooltipRef.current?.getBoundingClientRect()
      const width = tooltipRect?.width ?? 0
      const height = tooltipRect?.height ?? 0
      const halfWidth = width / 2
      const left = Math.min(Math.max(rect.left + rect.width / 2, halfWidth + 8), window.innerWidth - halfWidth - 8)
      setPosition({ left, top: side === 'top' ? rect.top - height : rect.bottom })
    }
    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, portal, side])

  const child = cloneElement(children, {
    'aria-describedby': open ? id : children.props['aria-describedby'],
    onMouseEnter: (event: React.MouseEvent) => {
      children.props.onMouseEnter?.(event)
      setOpen(true)
    },
    onMouseLeave: (event: React.MouseEvent) => {
      children.props.onMouseLeave?.(event)
      setOpen(false)
    },
    onFocus: (event: React.FocusEvent) => {
      children.props.onFocus?.(event)
      setOpen(true)
    },
    onBlur: (event: React.FocusEvent) => {
      children.props.onBlur?.(event)
      setOpen(false)
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      children.props.onKeyDown?.(event)
      if (event.key === 'Escape') setOpen(false)
    },
  })

  const tooltip = open ? (
    <span
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className={`pointer-events-none whitespace-nowrap rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-[11px] text-slate-200 shadow-lg ${
        portal
          ? 'fixed z-[100] -translate-x-1/2'
          : `absolute left-1/2 z-popover -translate-x-1/2 ${side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`
      }`}
      style={portal ? { left: position.left, top: side === 'top' ? position.top - 6 : position.top + 6 } : undefined}
    >
      {label}
    </span>
  ) : null

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      {child}
      {portal ? (typeof document !== 'undefined' ? createPortal(tooltip, document.body) : null) : tooltip}
    </span>
  )
}
