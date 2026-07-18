import { RefreshCw } from 'lucide-react'
import * as m from 'motion/react-m'
import { surfaceTransition } from '../../motion/tokens'

interface RefreshIconProps {
  refreshing?: boolean
  size?: number
}

export default function RefreshIcon({ refreshing = false, size = 12 }: RefreshIconProps) {
  return (
    <m.span
      className="block shrink-0"
      animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
      whileHover={refreshing ? undefined : { rotate: -18, scale: 1.08 }}
      transition={refreshing ? { duration: 0.8, ease: 'linear', repeat: Infinity } : surfaceTransition}
    >
      <RefreshCw size={size} />
    </m.span>
  )
}
