const AUTH_IDLE_GRACE_MS = 1000

const AUTH_ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
] as const

interface AuthIdleTimerOptions {
  enabled: boolean
  idleTimeoutSeconds: number
  onIdle: () => void
  target?: Window
}

export function startAuthIdleTimer({
  enabled,
  idleTimeoutSeconds,
  onIdle,
  target = window,
}: AuthIdleTimerOptions): () => void {
  if (!enabled || idleTimeoutSeconds <= 0) return () => {}

  let timer: ReturnType<typeof target.setTimeout> | undefined
  const timeoutMs = idleTimeoutSeconds * 1000 + AUTH_IDLE_GRACE_MS

  const schedule = () => {
    if (timer !== undefined) target.clearTimeout(timer)
    timer = target.setTimeout(onIdle, timeoutMs)
  }

  for (const eventName of AUTH_ACTIVITY_EVENTS) {
    target.addEventListener(eventName, schedule, { passive: true })
  }
  schedule()

  return () => {
    if (timer !== undefined) target.clearTimeout(timer)
    for (const eventName of AUTH_ACTIVITY_EVENTS) {
      target.removeEventListener(eventName, schedule)
    }
  }
}
