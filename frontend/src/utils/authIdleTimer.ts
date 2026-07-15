const AUTH_IDLE_GRACE_MS = 1000

const AUTH_ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
] as const

const AUTH_RESUME_EVENTS = [
  'focus',
  'pageshow',
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
  let deadline = Date.now() + timeoutMs
  let expired = false

  const expire = () => {
    if (expired) return
    expired = true
    if (timer !== undefined) target.clearTimeout(timer)
    timer = undefined
    onIdle()
  }

  const armTimer = () => {
    if (timer !== undefined) target.clearTimeout(timer)
    timer = target.setTimeout(expire, Math.max(0, deadline - Date.now()))
  }

  const recordActivity = () => {
    if (expired) return
    const now = Date.now()
    if (now >= deadline) {
      expire()
      return
    }
    deadline = now + timeoutMs
    armTimer()
  }

  const checkDeadline = () => {
    if (!expired && Date.now() >= deadline) expire()
  }

  for (const eventName of AUTH_ACTIVITY_EVENTS) {
    target.addEventListener(eventName, recordActivity, { passive: true })
  }
  for (const eventName of AUTH_RESUME_EVENTS) {
    target.addEventListener(eventName, checkDeadline, { passive: true })
  }
  target.document.addEventListener('visibilitychange', checkDeadline, { passive: true })
  armTimer()

  return () => {
    if (timer !== undefined) target.clearTimeout(timer)
    for (const eventName of AUTH_ACTIVITY_EVENTS) {
      target.removeEventListener(eventName, recordActivity)
    }
    for (const eventName of AUTH_RESUME_EVENTS) {
      target.removeEventListener(eventName, checkDeadline)
    }
    target.document.removeEventListener('visibilitychange', checkDeadline)
  }
}
