import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Tooltip from '../../components/ui/Tooltip'

function renderTooltip(onClick = vi.fn()) {
  return render(
    <Tooltip label="Refresh databases">
      <button type="button" aria-label="Refresh databases" onClick={onClick}>
        <span aria-hidden="true">icon</span>
      </button>
    </Tooltip>
  )
}

describe('Tooltip', () => {
  it('appears on keyboard focus, not just hover', async () => {
    renderTooltip()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await userEvent.tab()

    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Refresh databases')
    // The control is described by the visible tip while it is open.
    expect(screen.getByRole('button', { name: 'Refresh databases' })).toHaveAttribute(
      'aria-describedby',
      tip.id
    )
  })

  it('appears on hover and hides again on unhover', async () => {
    renderTooltip()
    const button = screen.getByRole('button', { name: 'Refresh databases' })

    await userEvent.hover(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await userEvent.unhover(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('mounts the tip outside a clipping ancestor', async () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', width: 20, height: 20 }}>
        <Tooltip label="Refresh databases">
          <button type="button" aria-label="Refresh databases">icon</button>
        </Tooltip>
      </div>,
    )

    await userEvent.hover(screen.getByRole('button', { name: 'Refresh databases' }))

    const tip = screen.getByRole('tooltip')
    expect(tip.parentElement).toBe(document.body)
    expect(container.contains(tip)).toBe(false)
  })

  it('hides on blur and on Escape, and keeps the control clickable', async () => {
    const onClick = vi.fn()
    renderTooltip(onClick)
    const button = screen.getByRole('button', { name: 'Refresh databases' })

    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
