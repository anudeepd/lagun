import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import Button from './Button'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  initialFocusRef?: RefObject<HTMLElement>
}

const FOCUSABLE_SELECTORS = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export default function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', initialFocusRef }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()

  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const getFocusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS))
      .filter(el => !el.hasAttribute('disabled'))

    const focusInitialTarget = window.requestAnimationFrame(() => {
      if (dialog.contains(document.activeElement)) return
      initialFocusRef?.current?.focus()
      if (!dialog.contains(document.activeElement)) {
        const focusables = getFocusables()
        focusables[0]?.focus() ?? dialog.focus()
      }
    })

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = getFocusables()
      if (focusables.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.cancelAnimationFrame(focusInitialTarget)
      window.removeEventListener('keydown', handler)
      const opener = openerRef.current
      if (opener?.isConnected) {
        opener.focus()
      }
    }
  }, [open, initialFocusRef])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative bg-surface-900 border border-surface-700 rounded-lg shadow-2xl w-full ${width} flex flex-col max-h-[90vh]`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <h2 id={titleId} className="text-sm font-semibold text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1" aria-label="Close dialog">
            <X size={14} />
          </Button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-surface-700 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
