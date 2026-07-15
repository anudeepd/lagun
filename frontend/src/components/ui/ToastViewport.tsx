import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { subscribeToasts, type Toast } from '../../utils/toast'

export default function ToastViewport() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    return subscribeToasts(toast => {
      setToasts(current => [...current, toast])
      window.setTimeout(() => {
        setToasts(current => current.filter(item => item.id !== toast.id))
      }, 5000)
    })
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[200] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map(toast => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl ${
            toast.kind === 'error'
              ? 'border-red-800 bg-red-950 text-red-100'
              : 'border-emerald-800 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.kind === 'error' ? <CircleAlert size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
          <p className="min-w-0 flex-1 break-words">{toast.message}</p>
          <button
            type="button"
            className="-mr-1 -mt-1 rounded p-1 text-current/70 hover:bg-black/20 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
            aria-label="Dismiss notification"
            onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
