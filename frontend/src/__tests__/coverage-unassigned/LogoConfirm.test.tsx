import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Logo from '../../components/ui/Logo'

describe('Logo', () => {
  it('renders every size with matching text and optional wordmark', () => {
    const { container, rerender } = render(<Logo size="sm" />)

    expect(container.querySelector('svg')).toHaveClass('w-7', 'h-7')
    expect(screen.getByText('Lagun')).toHaveClass('text-sm')

    rerender(<Logo size="md" />)
    expect(container.querySelector('svg')).toHaveClass('w-9', 'h-9')
    expect(screen.getByText('Lagun')).toHaveClass('text-base')

    rerender(<Logo size="lg" className="custom-logo" />)
    expect(container.querySelector('svg')).toHaveClass('w-14', 'h-14')
    expect(screen.getByText('Lagun')).toHaveClass('text-xl')
    expect(container.firstChild).toHaveClass('custom-logo')

    rerender(<Logo showText={false} />)
    expect(screen.queryByText('Lagun')).not.toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('uses the primary action style for non-destructive confirmations', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Continue"
        message="Continue with this action?"
        confirmLabel="Continue"
        cancelLabel="Go back"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )

    const confirm = screen.getByRole('button', { name: 'Continue' })
    expect(confirm).toHaveClass('bg-brand-600')
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument()

    await userEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
