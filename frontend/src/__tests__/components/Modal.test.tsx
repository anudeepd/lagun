import { useState } from 'react'
import { describe, expect, it } from 'vitest'
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

describe('Modal', () => {
  it('does not steal focus from a controlled textarea while typing', async () => {
    const user = userEvent.setup()
    render(<ControlledTextareaModal />)

    const textarea = screen.getByLabelText('Cell value')
    await user.type(textarea, 'large cell text')

    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('large cell text')
  })
})
