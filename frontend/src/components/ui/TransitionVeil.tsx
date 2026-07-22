import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, surfaceTransition } from '../../motion/tokens'
import Spinner from './Spinner'

interface Props {
  active: boolean
  label: string
}

export default function TransitionVeil({ active, label }: Props) {
  return (
    <AnimatePresence initial={false}>
      {active && (
        <m.div
          key="transition-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: surfaceTransition }}
          exit={{ opacity: 0, transition: exitTransition }}
          role="status"
          aria-label={label}
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface-950/60 backdrop-blur-[1px]"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: surfaceTransition }}
            exit={{ opacity: 0, scale: 0.94, transition: exitTransition }}
            className="flex items-center gap-2 rounded-full border border-surface-700 bg-surface-900/90 px-3 py-1.5 text-xs text-slate-400 shadow-lg"
          >
            <Spinner size="sm" />
            <span>{label}</span>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
