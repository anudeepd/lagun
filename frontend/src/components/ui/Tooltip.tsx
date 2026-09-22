import { cloneElement, useId, useState, type ReactElement } from 'react'

/** Props a wrapped control may already define; the tooltip chains, not replaces. */
interface TooltipChildProps {
  onMouseEnter?: React.MouseEventHandler
  onMouseLeave?: React.MouseEventHandler
  onFocus?: React.FocusEventHandler
  onBlur?: React.FocusEventHandler
  onKeyDown?: React.KeyboardEventHandler
  'aria-describedby'?: string
}

interface Props {
  /** Short description of the control. The control still needs its own
      accessible name (`aria-label`) — a tooltip is supplementary. */
  label: string
  children: ReactElement<TooltipChildProps>
  side?: 'top' | 'bottom'
}

/**
 * A small tooltip that appears on hover **and** keyboard focus.
 *
 * Native `title` attributes are invisible to keyboard users and do not exist on
 * touch, which is what made the app's icon-only controls hard to discover; this
 * is the one place that behaviour is defined.
 */
export default function Tooltip({ label, children, side = 'top' }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()

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

  return (
    <span className="relative inline-flex">
      {child}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`pointer-events-none absolute left-1/2 z-popover -translate-x-1/2 whitespace-nowrap rounded border border-surface-700 bg-surface-800 px-1.5 py-0.5 text-[11px] text-slate-200 shadow-lg ${
            side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {label}
        </span>
      )}
    </span>
  )
}
