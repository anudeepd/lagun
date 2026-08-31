import { createRoot } from 'react-dom/client'
import { m } from 'motion/react'

function Demo() {
  return (
    <m.div
      id="box"
      style={{ width: 200, height: 200, background: 'teal' }}
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
    />
  )
}

createRoot(document.getElementById('root')!).render(<Demo />)