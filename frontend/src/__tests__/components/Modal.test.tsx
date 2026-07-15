import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Modal from '../../components/ui/Modal'

function ControlledTextareaModal() {
  const [value, setValue] = useState('')

  return (
    <Modal open={true} onClose={() => {}} title="Edit cell">
      <textarea
        aria-label="Cell value"
        value={value}
        onChange={e => setValue(e.target.value)}
        autoFocus
      />
    </Modal>
  )
}

function OpenableModal({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button onClick={() => setOpen(true)}>Open editor</button>
      <Modal open={open} onClose={() => { setOpen(false); onClose() }} title="Edit cell">
        <button>First action</button>
        <button>Last action</button>
      </Modal>
    </>
  )
}

describe('Modal', () => {
  it('does not steal focus from a controlled textarea while typing', async () => {
    const user = userEvent.setup()
    render(<ControlledTextareaModal />)

    const textarea = screen.getByLabelText('Cell value')
    await user.type(textarea, 'large cell text')

    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('large cell text')
  })

  it('closes with Escape and returns focus to opener', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<OpenableModal onClose={onClose} />)

    const opener = screen.getByRole('button', { name: 'Open editor' })
    await user.click(opener)
    expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('cycles Tab within dialog', async () => {
    const user = userEvent.setup()
    render(<OpenableModal onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Open editor' }))
    const closeButton = screen.getByRole('button', { name: 'Close dialog' })
    const lastAction = screen.getByRole('button', { name: 'Last action' })
    closeButton.focus()

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(lastAction).toHaveFocus()
  })
})
