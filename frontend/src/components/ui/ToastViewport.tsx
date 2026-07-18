import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { AnimatePresence, useIsPresent } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'
import { useToastQueue, type ToastPauseReason } from './useToastQueue'
import type { Toast } from '../../utils/toast'

interface ToastItemProps {
  toast: Toast
  dismiss: (id: number) => void
  pause: (id: number, reason: ToastPauseReason) => void
  resume: (id: number, reason: ToastPauseReason) => void
}

function ToastItem({ toast, dismiss, pause, resume }: ToastItemProps) {
  const isPresent = useIsPresent()

  return (
    <m.div
      layout="position"
      initial={{ opacity: 0, x: motionDistance.spatial * 2, y: -motionDistance.surface, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1, transition: surfaceTransition }}
      exit={{ opacity: 0, x: motionDistance.spatial, scale: 0.94, transition: exitTransition }}
      role={isPresent ? (toast.kind === 'error' ? 'alert' : 'status') : undefined}
      aria-hidden={!isPresent || undefined}
      onPointerEnter={() => pause(toast.id, 'hover')}
      onPointerLeave={() => resume(toast.id, 'hover')}
      onFocusCapture={() => pause(toast.id, 'focus')}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume(toast.id, 'focus')
      }}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl ${isPresent ? 'pointer-events-auto' : 'pointer-events-none'} ${
        toast.kind === 'error'
          ? 'border-red-800 bg-red-950 text-red-100'
          : 'border-emerald-800 bg-emerald-950 text-emerald-100'
      }`}
    >
      {toast.kind === 'error' ? <CircleAlert size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
      <p className="min-w-0 flex-1 break-words">{toast.message}</p>
      <button
        type="button"
        className="lagun-interactive -mr-1 -mt-1 rounded p-1 text-current/70 hover:bg-black/20 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
        aria-label="Dismiss notification"
        tabIndex={isPresent ? 0 : -1}
        disabled={!isPresent}
        onClick={() => dismiss(toast.id)}
      >
        <X size={14} />
      </button>
    </m.div>
  )
}

export default function ToastViewport() {
  const { toasts, dismiss, pause, resume } = useToastQueue()

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-toast flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false} mode="sync">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} dismiss={dismiss} pause={pause} resume={resume} />
        ))}
      </AnimatePresence>
    </div>
  )
}
