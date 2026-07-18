import { useCallback, useEffect, useReducer, useRef } from 'react'
import { subscribeToasts, type Toast } from '../../utils/toast'

export type ToastPauseReason = 'hover' | 'focus'

interface ToastQueueItem extends Toast {
  pauseReasons: ToastPauseReason[]
  remainingMs: number
}

type Action =
  | { type: 'add'; toast: Toast }
  | { type: 'dismiss'; id: number }
  | { type: 'pause'; id: number; reason: ToastPauseReason; remainingMs: number }
  | { type: 'resume'; id: number; reason: ToastPauseReason }

const TOAST_DURATION_MS = 5000

function reducer(state: ToastQueueItem[], action: Action): ToastQueueItem[] {
  switch (action.type) {
    case 'add':
      return [...state, { ...action.toast, pauseReasons: [], remainingMs: TOAST_DURATION_MS }]
    case 'dismiss':
      return state.filter(item => item.id !== action.id)
    case 'pause':
      return state.map(item => item.id === action.id
        ? {
            ...item,
            remainingMs: Math.max(0, action.remainingMs),
            pauseReasons: item.pauseReasons.includes(action.reason)
              ? item.pauseReasons
              : [...item.pauseReasons, action.reason],
          }
        : item)
    case 'resume':
      return state.map(item => item.id === action.id
        ? { ...item, pauseReasons: item.pauseReasons.filter(reason => reason !== action.reason) }
        : item)
  }
}

export function useToastQueue() {
  const [toasts, dispatch] = useReducer(reducer, [])
  const timersRef = useRef(new Map<number, number>())
  const deadlinesRef = useRef(new Map<number, number>())
  const remainingRef = useRef(new Map<number, number>())

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    timersRef.current.delete(id)
    deadlinesRef.current.delete(id)
  }, [])

  const dismiss = useCallback((id: number) => {
    clearTimer(id)
    remainingRef.current.delete(id)
    dispatch({ type: 'dismiss', id })
  }, [clearTimer])

  const pause = useCallback((id: number, reason: ToastPauseReason) => {
    const deadline = deadlinesRef.current.get(id)
    const remainingMs = deadline === undefined
      ? (remainingRef.current.get(id) ?? TOAST_DURATION_MS)
      : deadline - performance.now()
    remainingRef.current.set(id, remainingMs)
    clearTimer(id)
    dispatch({ type: 'pause', id, reason, remainingMs })
  }, [clearTimer])

  const resume = useCallback((id: number, reason: ToastPauseReason) => {
    dispatch({ type: 'resume', id, reason })
  }, [])

  useEffect(() => subscribeToasts(toast => dispatch({ type: 'add', toast })), [])

  useEffect(() => {
    const liveIds = new Set(toasts.map(toast => toast.id))
    for (const id of timersRef.current.keys()) {
      if (!liveIds.has(id)) clearTimer(id)
    }

    for (const toast of toasts) {
      if (toast.pauseReasons.length > 0 || timersRef.current.has(toast.id)) continue
      const delay = Math.max(0, toast.remainingMs)
      remainingRef.current.set(toast.id, delay)
      deadlinesRef.current.set(toast.id, performance.now() + delay)
      const timer = window.setTimeout(() => dismiss(toast.id), delay)
      timersRef.current.set(toast.id, timer)
    }
  }, [clearTimer, dismiss, toasts])

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
    deadlinesRef.current.clear()
    remainingRef.current.clear()
  }, [])

  return { toasts, dismiss, pause, resume }
}
