import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showToast } from '../../utils/toast'
import { useToastQueue } from '../../components/ui/useToastQueue'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toast queue pause reasons', () => {
  it('can pause an identity before its timer is known', () => {
    const { result } = renderHook(() => useToastQueue())

    act(() => result.current.pause(999, 'hover'))
    act(() => showToast('Saved'))

    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('does not duplicate a pause reason already held by the toast', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    const id = result.current.toasts[0].id

    act(() => result.current.pause(id, 'hover'))
    act(() => result.current.pause(id, 'hover'))
    expect(result.current.toasts[0].pauseReasons).toEqual(['hover'])

    act(() => result.current.resume(id, 'hover'))
    act(() => vi.advanceTimersByTime(4_999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('ignores pause and resume actions for a different toast identity', () => {
    const { result } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    const id = result.current.toasts[0].id

    act(() => result.current.pause(999, 'hover'))
    act(() => result.current.resume(999, 'focus'))

    expect(result.current.toasts[0].id).toBe(id)
    expect(result.current.toasts[0].pauseReasons).toEqual([])
  })

  it('clears every timer on unmount', () => {
    const { result, unmount } = renderHook(() => useToastQueue())
    act(() => showToast('Saved'))
    expect(result.current.toasts).toHaveLength(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
