import { RefreshCw } from 'lucide-react'

interface RefreshIconProps {
  refreshing?: boolean
  size?: number
}

export default function RefreshIcon({ refreshing = false, size = 12 }: RefreshIconProps) {
  // Decorative: the icon always sits inside a button whose label (or the
  // labelled loading region next to it) carries the state for assistive tech.
  return <RefreshCw size={size} aria-hidden="true" focusable="false" className={refreshing ? 'animate-spin' : undefined} />
}
