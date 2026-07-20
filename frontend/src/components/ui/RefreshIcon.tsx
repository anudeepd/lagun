import { RefreshCw } from 'lucide-react'

interface RefreshIconProps {
  refreshing?: boolean
  size?: number
}

export default function RefreshIcon({ refreshing = false, size = 12 }: RefreshIconProps) {
  return <RefreshCw size={size} />
}
