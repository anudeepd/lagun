import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Select from '../../components/ui/Select'

describe('Select', () => {
  it('connects an error message to the trigger', () => {
    render(
      <Select label="Format" error="Choose a format">
        <option value="csv">CSV</option>
      </Select>,
    )

    const trigger = screen.getByRole('button', { name: 'Format' })
    const error = screen.getByRole('alert')

    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(trigger).toHaveAttribute('aria-describedby', error.id)
    expect(error).toHaveTextContent('Choose a format')
  })
})
