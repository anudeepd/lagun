import { useEffect, useRef, useState } from 'react'

/** Shows a cue only while a destination surface is actually loading. */
export function useHandoff(value: string | null, loading: boolean, minVisibleMs = 180) {
  const previousValue = useRef(value)
  const previousLoading = useRef(loading)
  const [active, setActive] = useState(false)
  const startedAt = useRef(0)

  useEffect(() => {
    const valueChanged = previousValue.current !== value
    const startedLoading = !previousLoading.current && loading
    previousValue.current = value
    previousLoading.current = loading

    if ((valueChanged || startedLoading) && loading) {
      startedAt.current = performance.now()
      setActive(true)
    }
  }, [loading, value])

  useEffect(() => {
    if (!loading && active) {
      const remaining = Math.max(0, minVisibleMs - (performance.now() - startedAt.current))
      const timer = window.setTimeout(() => setActive(false), remaining)
      return () => window.clearTimeout(timer)
    }
    if (!loading) setActive(false)
  }, [active, loading, minVisibleMs])

  return active
}
