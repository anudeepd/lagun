import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import Modal from './src/components/ui/Modal'

function Demo() {
  const [open, setOpen] = useState(false)
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <button id="open" onClick={() => setOpen(true)}>open</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Export data">
          <p>rows</p>
        </Modal>
      </MotionConfig>
    </LazyMotion>
  )
}

createRoot(document.getElementById('root')!).render(<Demo />)
