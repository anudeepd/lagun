import { createRoot } from 'react-dom/client'
import { animate } from 'motion/react'
import { useState } from 'react'

function Demo() {
  const [n, setN] = useState(0)
  return (
    <>
      <button id="go" onClick={() => {
        animate('#box', { opacity: [0, 1], scale: [0.5, 1] }, { duration: 0.5 })
        setN(x => x + 1)
      }}>go {n}</button>
      <div id="box" style={{ width: 200, height: 200, background: 'teal', opacity: 0 }} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Demo />)