import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Input from '../../components/ui/Input'

afterEach(cleanup)

describe('Input', () => {
  it('derives an accessible id and error description from its label', () => {
    const ref = createRef<HTMLInputElement>()
    render(
      <Input
        ref={ref}
        label="User Name!"
        error="A name is required"
        defaultValue="Ada"
      />,
    )

    const input = screen.getByLabelText('User Name!')
    const error = screen.getByRole('alert')

    expect(ref.current).toBe(input)
    expect(input).toHaveAttribute('id', 'input-user-name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', error.id)
    expect(input).toHaveClass('border-red-500')
    expect(error).toHaveTextContent('A name is required')
  })

  it('keeps caller-provided ids and accessibility props when valid', () => {
    render(
      <>
        <p id="host-hint">Host name</p>
        <Input
          id="db-host"
          aria-invalid={false}
          aria-describedby="host-hint"
          className="custom-width"
          placeholder="localhost"
        />
      </>,
    )

    const input = screen.getByPlaceholderText('localhost')
    expect(input).toHaveAttribute('id', 'db-host')
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(input).toHaveAttribute('aria-describedby', 'host-hint')
    expect(input).toHaveClass('custom-width')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders an unlabelled input without inventing ids', () => {
    render(<Input data-testid="bare-input" />)

    const input = screen.getByTestId('bare-input')
    expect(input).not.toHaveAttribute('id')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).not.toHaveAttribute('aria-describedby')
  })
})
