import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'

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
  useMenuKeyboard(ref, onClose)

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
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  return createPortal(
    <m.div
      ref={ref}
      role="menu"
      aria-label="Grid actions"
      initial={{ opacity: 0, scale: 0.9, y: -motionDistance.surface }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: surfaceTransition }}
      exit={{ opacity: 0, scale: 0.92, y: -motionDistance.subtle, transition: exitTransition }}
      className="fixed z-popover min-w-[180px] rounded-md border border-surface-700 bg-surface-900 py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.type === 'separator' ? (
          <div key={i} className="border-t border-surface-700 my-1" />
        ) : (
          <button
            key={i}
            role="menuitem"
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
    </m.div>,
    document.body
  )
}
