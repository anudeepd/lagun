import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmDialog from '../../components/ui/ConfirmDialog'

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return render(
    <ConfirmDialog
      open
      title="Drop Table"
      message="Drop this table permanently? This action cannot be undone."
      confirmLabel="Drop Table"
      danger
      onConfirm={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />
  )
}

describe('ConfirmDialog accessibility', () => {
  it('is announced as an alert dialog, not a plain dialog', () => {
    renderDialog()
    expect(screen.getByRole('alertdialog', { name: 'Drop Table' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('links the consequence text to the dialog', () => {
    renderDialog()
    const dialog = screen.getByRole('alertdialog', { name: 'Drop Table' })
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'This action cannot be undone.'
    )
  })

  it('starts focus on the safe action and closes on Escape', async () => {
    const onClose = vi.fn()
    renderDialog({ onClose })

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    // Modal applies its initial focus in a rAF; Cancel is the safe default for a
    // destructive action even though the confirm button comes first in the DOM.
    await waitFor(() => expect(cancel).toHaveFocus())

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
