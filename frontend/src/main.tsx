import React from 'react'
import ReactDOM from 'react-dom/client'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import App from './App'
import { installScrollbarFallback } from './utils/scrollbarFallback'
import './index.css'

// Before the first paint: Firefox and Waterfox ignore the `::-webkit-scrollbar`
// rules in index.css and would otherwise show the platform scrollbar.
installScrollbarFallback()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </LazyMotion>
  </React.StrictMode>
)
