import React from 'react'
import ReactDOM from 'react-dom/client'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </LazyMotion>
  </React.StrictMode>
)
