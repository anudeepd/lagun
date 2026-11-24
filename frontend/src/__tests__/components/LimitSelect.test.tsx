import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LimitSelect from '../../components/ui/LimitSelect'

describe('LimitSelect', () => {
  it('accepts a typed limit above the preset range', async () => {
    const onChange = vi.fn()
    render(<LimitSelect value={1000} options={[100, 500, 1000, 10000]} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    await userEvent.click(screen.getByRole('option', { name: 'Custom…' }))

    const input = screen.getByRole('spinbutton', { name: /Custom row limit/i })
    await userEvent.clear(input)
    await userEvent.type(input, '250000')
    await userEvent.click(screen.getByRole('button', { name: 'Apply row limit' }))

    expect(onChange).toHaveBeenCalledWith(250000)
  })

  it('rejects a typed limit above the server ceiling', async () => {
    const onChange = vi.fn()
    render(<LimitSelect value={1000} options={[100, 500, 1000, 10000]} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    await userEvent.click(screen.getByRole('option', { name: 'Custom…' }))

    const input = screen.getByRole('spinbutton', { name: /Custom row limit/i })
    await userEvent.clear(input)
    await userEvent.type(input, '1000001')
    await userEvent.click(screen.getByRole('button', { name: 'Apply row limit' }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('1 and 1,000,000')
  })
})
