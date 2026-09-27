import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Progress from '../../components/ui/Progress'

describe('Progress', () => {
  it('reports a determinate value, clamped to 0-100', () => {
    const { rerender } = render(<Progress value={42} label="Uploading file" />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading file' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')

    rerender(<Progress value={140} label="Uploading file" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    rerender(<Progress value={-10} label="Uploading file" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('reports no percentage when there is no honest total', () => {
    const { rerender } = render(<Progress label="Importing" />)
    const bar = screen.getByRole('progressbar', { name: 'Importing' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('aria-valuetext', 'In progress')

    // `null` is the same statement as an absent value: a known-unknowable total
    // must not be rendered as 0%.
    rerender(<Progress value={null} label="Importing" />)
    const nulled = screen.getByRole('progressbar', { name: 'Importing' })
    expect(nulled).not.toHaveAttribute('aria-valuenow')
    expect(nulled).toHaveAttribute('aria-valuetext', 'In progress')
  })

  it('moves the determinate fill to each new value', () => {
    const { rerender } = render(<Progress value={20} />)
    expect(screen.getByTestId('progress-fill').style.transform).toBe('scaleX(0.2)')

    rerender(<Progress value={70} />)
    expect(screen.getByTestId('progress-fill').style.transform).toBe('scaleX(0.7)')
  })
})
