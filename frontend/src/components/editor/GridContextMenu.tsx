import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ContextMenuItem =
  | { type: 'item'; label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }
  | { type: 'separator' }

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function GridContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Clamp position to viewport after first render
  useLayoutEffect(() => {
    if (!ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] bg-surface-900 border border-surface-700 rounded-md shadow-2xl py-1 min-w-[180px]"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.type === 'separator' ? (
          <div key={i} className="border-t border-surface-700 my-1" />
        ) : (
          <button
            key={i}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left ${
              item.danger
                ? 'text-red-400 hover:bg-red-950/40'
                : 'text-slate-300 hover:bg-surface-800'
            }`}
            onClick={item.onClick}
          >
            {item.icon}
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
