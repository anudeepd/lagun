import { type ElementType, type HTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'

type LabelTag = 'label' | 'span' | 'div' | 'p' | 'h3'

interface LabelProps extends Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'> {
  /**
   * Element to render. Defaults to `label`; pass a plain element for group
   * headings that do not label a single control.
   */
  as?: LabelTag
  /** Id of the form control this label describes. Only meaningful for `as="label"`. */
  htmlFor?: string
  className?: string
  children: ReactNode
}

/**
 * The shared micro-label convention: small, medium-weight, uppercase text with
 * wide letter-spacing. Renders a real `<label htmlFor>` when it names a form
 * control (or, without `htmlFor`, when it wraps one) and a plain element when
 * it is a group heading.
 */
export default function Label({ as = 'label', htmlFor, className, children, ...props }: LabelProps) {
  const Tag = as as ElementType
  return (
    <Tag
      {...(as === 'label' ? { htmlFor } : {})}
      className={clsx('text-xs font-medium uppercase tracking-wide text-slate-400', className)}
      {...props}
    >
      {children}
    </Tag>
  )
}
