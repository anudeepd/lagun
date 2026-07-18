import type { Transition } from 'motion/react'

export const motionDuration = {
  instant: 0.1,
  micro: 0.18,
  surface: 0.28,
  spatial: 0.38,
} as const

export const motionEase = {
  move: [0.16, 1, 0.3, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
} as const

export const motionDistance = {
  subtle: 6,
  surface: 14,
  spatial: 24,
} as const

export const surfaceTransition: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 30,
  mass: 0.72,
}

export const spatialTransition: Transition = {
  type: 'spring',
  stiffness: 340,
  damping: 27,
  mass: 0.82,
}

export const exitTransition: Transition = {
  duration: motionDuration.micro,
  ease: motionEase.exit,
}
