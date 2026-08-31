import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AnimatePresence, m, useIsPresent } from 'motion/react'
import { X } from 'lucide-react'

function Modal({ onClose }) {
  const isPresent = useIsPresent()
  return (
    <m.div
      className="fixed inset-0 z-modal flex items-center justify-center p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      aria-hidden={!isPresent || undefined}
    >
      <m.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 6, transition: { type: 'spring', stiffness: 560, damping: 24, mass: 0.5 } }}
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-surface-700 bg-surface-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Export data</h2>
          <button onClick={onClose} aria-label="Close dialog"><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">rows</div>
      </m.div>
    </m.div>
  )
}

function Demo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button id="open" onClick={() => setOpen(true)}>open</button>
      <AnimatePresence initial={false} mode="sync">
        {open && <Modal key="shell" onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Demo />)