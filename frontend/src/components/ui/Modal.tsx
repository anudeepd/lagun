import { forwardRef, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, useIsPresent } from 'motion/react'
import * as m from 'motion/react-m'
import { X } from 'lucide-react'
import Button from './Button'
import { exitSpring, motionDistance, popOffTransition, spatialTransition, surfaceTransition } from '../../motion/tokens'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  initialFocusRef?: RefObject<HTMLElement>
  restoreFocus?: boolean
  /** Destructive/irreversible confirmations: `role="alertdialog"` so assistive
      tech announces the prompt immediately instead of as a plain dialog. */
  alert?: boolean
  /** id of the element describing the dialog's consequence, linked with
      `aria-describedby`. */
  descriptionId?: string
}

const FOCUSABLE_SELECTORS = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

interface ModalShellProps extends Omit<ModalProps, 'open' | 'restoreFocus'> {
  dialogRef: RefObject<HTMLDivElement>
  titleId: string
}

const ModalShell = forwardRef<HTMLDivElement, ModalShellProps>(function ModalShell({ onClose, title, children, footer, width = 'max-w-lg', dialogRef, titleId, alert, descriptionId }, presenceRef) {
  const isPresent = useIsPresent()

  useEffect(() => {
    if (dialogRef.current) dialogRef.current.inert = !isPresent
  }, [dialogRef, isPresent])

  return (
    <m.div
      ref={presenceRef}
      className={`fixed inset-0 z-modal flex items-center justify-center lagun-safe-area ${isPresent ? '' : 'pointer-events-none'}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: spatialTransition }}
      exit={{ opacity: 0, transition: exitSpring }}
      aria-hidden={!isPresent || undefined}
    >
      {/* Full-viewport backdrop: only the fade animates. The blur lives in a
          class so it is identical at rest but never interpolated - animating
          backdrop-filter repaints the entire viewport on every frame. */}
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: surfaceTransition }}
        exit={{ opacity: 0, transition: exitSpring }}
        className="absolute inset-0 bg-black/60 backdrop-blur-[5px]"
        aria-hidden="true"
        onClick={isPresent ? onClose : undefined}
      />
      <m.div
        ref={dialogRef}
        role={isPresent ? (alert ? 'alertdialog' : 'dialog') : undefined}
        aria-modal={isPresent ? 'true' : undefined}
        aria-labelledby={isPresent ? titleId : undefined}
        aria-describedby={isPresent ? descriptionId : undefined}
        tabIndex={isPresent ? -1 : undefined}
        initial={{ opacity: 0, y: motionDistance.subtle, scale: 0.96, rotateX: -1 }}
        animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0, transition: { ...spatialTransition, delay: 0.05 } }}
        exit={{ opacity: [1, 0.85, 0], y: [0, -3, 8], scale: [1, 1.03, 0.92], transition: popOffTransition }}
        className={`relative flex max-h-[90vh] w-full flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-2xl ${width}`}
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <h2 id={titleId} className="text-balance text-sm font-semibold text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1" aria-label="Close dialog" disabled={!isPresent}>
            <X size={14} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-surface-700 px-4 py-3">{footer}</div>}
      </m.div>
    </m.div>
  )
})

export default function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', initialFocusRef, restoreFocus = true, alert, descriptionId }: ModalProps) {
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
        // HTMLElement.focus() returns undefined, so `focusables[0]?.focus() ?? dialog.focus()`
        // always fell through and moved focus to the dialog container instead of
        // the first control.
        const first = getFocusables()[0]
        if (first) first.focus()
        else dialog.focus()
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
      if (restoreFocus && opener?.isConnected) {
        opener.focus()
      }
    }
  }, [open, initialFocusRef, restoreFocus])

  const overlayRoot = document.getElementById('lagun-overlays')
  if (!overlayRoot) throw new Error('Missing #lagun-overlays portal root')

  return createPortal(
    <AnimatePresence initial={false} mode="sync">
      {open && (
        <ModalShell
          key="modal-shell"
          onClose={onClose}
          title={title}
          footer={footer}
          width={width}
          initialFocusRef={initialFocusRef}
          dialogRef={dialogRef}
          titleId={titleId}
          alert={alert}
          descriptionId={descriptionId}
        >
          {children}
        </ModalShell>
      )}
    </AnimatePresence>,
    overlayRoot,
  )
}
