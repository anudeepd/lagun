export type ToastKind = 'success' | 'error'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
}

type Listener = (toast: Toast) => void
const listeners = new Set<Listener>()
let nextId = 0

export function showToast(message: string, kind: ToastKind = 'success') {
  const toast = { id: nextId++, message, kind }
  listeners.forEach(listener => listener(toast))
}

export function subscribeToasts(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
