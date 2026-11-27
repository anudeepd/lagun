import { createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GridContextMenu from '../../components/editor/GridContextMenu'

describe('GridContextMenu interaction behavior', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders separators, icons, danger styling, and runs item actions', () => {
    const onCopy = vi.fn()
    const onDelete = vi.fn()
    const iconRef = createRef<HTMLSpanElement>()
    render(
      <GridContextMenu
        x={10}
        y={20}
        items={[
          { type: 'item', label: 'Copy cell', icon: <span ref={iconRef}>C</span>, onClick: onCopy },
          { type: 'separator' },
          { type: 'item', label: 'Delete row', danger: true, onClick: onDelete },
        ]}
        onClose={vi.fn()}
      />,
    )

    expect(iconRef.current).not.toBeNull()
    expect(document.querySelector('.border-t.border-surface-700.my-1')).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Delete row' })).toHaveClass('text-red-400')
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy cell/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete row' }))
    expect(onCopy).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('closes only for mousedown outside the menu', async () => {
    const onClose = vi.fn()
    render(<GridContextMenu x={10} y={20} items={[]} onClose={onClose} />)
    const menu = screen.getByRole('menu', { name: 'Grid actions' })
    fireEvent.mouseDown(menu)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('prevents the native context menu and updates position when props change', () => {
    const { rerender } = render(<GridContextMenu x={10} y={20} items={[]} onClose={vi.fn()} />)
    const menu = screen.getByRole('menu', { name: 'Grid actions' })
    expect(fireEvent.contextMenu(menu)).toBe(false)

    rerender(<GridContextMenu x={200} y={220} items={[]} onClose={vi.fn()} />)
    expect(menu.style.left).toBe('200px')
    expect(menu.style.top).toBe('220px')
  })
})
