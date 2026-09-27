import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GridContextMenu from '../../components/editor/GridContextMenu'
import Select from '../../components/ui/Select'

async function nextFrame() {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

describe('menu keyboard — Tab advances focus', () => {
  it('closes the menu on Tab and moves focus to the next control instead of trapping it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <button>Opener</button>
        <GridContextMenu
          x={8}
          y={8}
          items={[{ type: 'item', label: 'Copy cell', onClick: () => {} }]}
          onClose={onClose}
        />
        <button>Next control</button>
      </>,
    )
    await nextFrame()
    await screen.findByRole('menuitem', { name: 'Copy cell' })

    await user.keyboard('{Tab}')

    expect(onClose).toHaveBeenCalled()
  })

  it('still closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <GridContextMenu
        x={8}
        y={8}
        items={[{ type: 'item', label: 'Copy cell', onClick: () => {} }]}
        onClose={onClose}
      />,
    )
    await nextFrame()
    await screen.findByRole('menuitem', { name: 'Copy cell' })

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
  })
})

describe('Select listbox — Tab advances focus', () => {
  it('closes the listbox on Tab and returns focus to the trigger so Tab reaches the next control', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Select aria-label="Engine" defaultValue="InnoDB">
          <option>InnoDB</option>
          <option>MyISAM</option>
        </Select>
        <button>Next control</button>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Engine' }))
    await screen.findByRole('listbox')
    const options = await screen.findAllByRole('option')
    options[1].focus()
    expect(options[1]).toHaveFocus()
    fireEvent.keyDown(options[1], { key: 'Tab' })


    // The listbox closes without trapping Tab: focus returns to the trigger
    // so the browser can advance it to the next control in tab order.
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('button', { name: 'Engine' })).toHaveFocus()
    await user.keyboard('{Tab}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus())
  })

  it('wraps Tab inside a dialog instead of leaving it', async () => {
    const user = userEvent.setup()
    render(
      <div role="dialog" aria-label="Create table">
        <Select aria-label="Engine" defaultValue="InnoDB">
          <option>InnoDB</option>
          <option>MyISAM</option>
        </Select>
        <button>Dialog action</button>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: 'Engine' }))
    await screen.findByRole('listbox')
    const options = await screen.findAllByRole('option')
    options[options.length - 1].focus()
    await user.keyboard('{Tab}')

    // Wrapping keeps the listbox open and cycles to the first dialog control.
    await screen.findByRole('listbox')
    expect(screen.getByRole('button', { name: 'Engine' })).toHaveFocus()
  })
})
