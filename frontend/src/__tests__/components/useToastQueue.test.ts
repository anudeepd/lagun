import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showToast } from '../../utils/toast'
import { useToastQueue } from '../../components/ui/useToastQueue'

describe('useToastQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('dismisses a toast after five seconds', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    expect(result.current.toasts).toHaveLength(1)

    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('pauses on hover and resumes from the remaining duration', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    const id = result.current.toasts[0].id

    act(() => vi.advanceTimersByTime(2000))
    act(() => result.current.pause(id, 'hover'))
    act(() => vi.advanceTimersByTime(10000))
    expect(result.current.toasts).toHaveLength(1)

    act(() => result.current.resume(id, 'hover'))
    act(() => vi.advanceTimersByTime(2999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('waits for both hover and focus pause reasons to clear', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    const id = result.current.toasts[0].id

    act(() => vi.advanceTimersByTime(2000))
    act(() => result.current.pause(id, 'hover'))
    act(() => result.current.pause(id, 'focus'))
    act(() => result.current.resume(id, 'hover'))
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.toasts).toHaveLength(1)

    act(() => result.current.resume(id, 'focus'))
    act(() => vi.advanceTimersByTime(2999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('cleans up manual dismissals without a late callback', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    const id = result.current.toasts[0].id
    act(() => result.current.dismiss(id))
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.toasts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
