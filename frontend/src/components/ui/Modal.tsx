import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, useIsPresent } from 'motion/react'
import * as m from 'motion/react-m'
import { X } from 'lucide-react'
import Button from './Button'
import { exitTransition, motionDistance, spatialTransition } from '../../motion/tokens'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  initialFocusRef?: RefObject<HTMLElement>
  restoreFocus?: boolean
}

const FOCUSABLE_SELECTORS = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

interface ModalShellProps extends Omit<ModalProps, 'open' | 'restoreFocus'> {
  dialogRef: RefObject<HTMLDivElement>
  titleId: string
}

function ModalShell({ onClose, title, children, footer, width = 'max-w-lg', dialogRef, titleId }: ModalShellProps) {
  const isPresent = useIsPresent()

  useEffect(() => {
    if (dialogRef.current) dialogRef.current.inert = !isPresent
  }, [dialogRef, isPresent])

  return (
    <m.div
      className={`fixed inset-0 z-modal flex items-center justify-center p-4 ${isPresent ? '' : 'pointer-events-none'}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: spatialTransition }}
      exit={{ opacity: 0, transition: exitTransition }}
      aria-hidden={!isPresent || undefined}
    >
      <m.div
        initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
        animate={{ opacity: 1, backdropFilter: 'blur(5px)', transition: { duration: 0.3 } }}
        exit={{ opacity: 0, backdropFilter: 'blur(0px)', transition: exitTransition }}
        className="absolute inset-0 bg-black/60"
        aria-hidden="true"
        onClick={isPresent ? onClose : undefined}
      />
      <m.div
        ref={dialogRef}
        role={isPresent ? 'dialog' : undefined}
        aria-modal={isPresent ? 'true' : undefined}
        aria-labelledby={isPresent ? titleId : undefined}
        tabIndex={isPresent ? -1 : undefined}
        initial={{ opacity: 0, y: motionDistance.spatial, scale: 0.9, rotateX: -3 }}
        animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0, transition: spatialTransition }}
        exit={{ opacity: 0, y: motionDistance.surface, scale: 0.94, transition: exitTransition }}
        className={`relative flex max-h-[90vh] w-full flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-2xl ${width}`}
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1" aria-label="Close dialog" disabled={!isPresent}>
            <X size={14} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-surface-700 px-4 py-3">{footer}</div>}
      </m.div>
    </m.div>
  )
}

export default function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', initialFocusRef, restoreFocus = true }: ModalProps) {
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
        >
          {children}
        </ModalShell>
      )}
    </AnimatePresence>,
    overlayRoot,
  )
}
