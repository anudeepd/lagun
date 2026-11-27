import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastViewport from '../../components/ui/ToastViewport'
import { showToast } from '../../utils/toast'

vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, AnimatePresence: ({ children }: { children: React.ReactNode }) => children }
})

vi.mock('motion/react-m', async () => {
  const React = await import('react')
  return {
    div: React.forwardRef(function MockDiv(
      {
        children,
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        layout: _layout,
        ...props
      }: Record<string, unknown>,
      ref,
    ) {
      return React.createElement('div', { ...props, ref }, children as React.ReactNode)
    }),
  }
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ToastViewport interactions', () => {
  it('pauses while hovered and dismisses after the remaining timeout', async () => {
    render(<ToastViewport />)
    act(() => showToast('Saved'))
    const toast = screen.getByRole('status')

    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(8_000))
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(4_999))
    expect(screen.queryByRole('status')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('pauses for focus until focus leaves the toast subtree', () => {
    render(<ToastViewport />)
    act(() => showToast('Could not save', 'error'))
    const toast = screen.getByRole('alert')

    act(() => vi.advanceTimersByTime(2_000))
    fireEvent.focus(toast)
    fireEvent.blur(toast, { relatedTarget: screen.getByRole('button', { name: 'Dismiss notification' }) })
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    fireEvent.blur(toast, { relatedTarget: document.body })
    act(() => vi.advanceTimersByTime(2_999))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dismisses immediately from the notification button', () => {
    render(<ToastViewport />)
    act(() => showToast('Saved'))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })
})
