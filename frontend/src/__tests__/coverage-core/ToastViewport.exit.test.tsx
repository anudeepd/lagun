import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToastViewport from '../../components/ui/ToastViewport'
import { showToast } from '../../utils/toast'

vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useIsPresent: () => false }
})

afterEach(cleanup)

describe('ToastViewport during an exit animation', () => {
  it('removes the live role and disables controls while still painting', () => {
    render(<ToastViewport />)
    act(() => showToast('Closing', 'error'))

    const text = screen.getByText('Closing')
    const toast = text.closest('.pointer-events-none') as HTMLElement
    const dismiss = document.querySelector(
      'button[aria-label="Dismiss notification"]',
    ) as HTMLButtonElement

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(toast).toBeInTheDocument()
    expect(dismiss).toBeDisabled()
    expect(dismiss).toHaveAttribute('tabindex', '-1')

    fireEvent.pointerEnter(toast)
    fireEvent.pointerLeave(toast)
    fireEvent.focus(toast)
    fireEvent.blur(toast, { relatedTarget: document.body })
    expect(toast).toBeInTheDocument()
  })
})
