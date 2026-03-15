import { type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'
import Button from './Button'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}

export default function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-surface-900 border border-surface-700 rounded-lg shadow-2xl w-full ${width} flex flex-col max-h-[90vh]`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-1">
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
