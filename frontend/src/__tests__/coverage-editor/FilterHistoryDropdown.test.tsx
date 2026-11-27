import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FilterHistoryDropdown from '../../components/editor/FilterHistoryDropdown'

const originalRect = HTMLElement.prototype.getBoundingClientRect

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

describe('FilterHistoryDropdown behavior', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  it('disables the trigger when there is no history and when explicitly disabled', () => {
    const { rerender } = render(
      <FilterHistoryDropdown history={[]} onSelect={vi.fn()} />,
    )
    const empty = screen.getByRole('button', { name: 'Recent filters' })
    expect(empty).toBeDisabled()
    expect(empty).toHaveAttribute('title', 'No recent filters yet')

    rerender(<FilterHistoryDropdown history={['id = 1']} disabled onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Recent filters' })).toBeDisabled()
  })

  it('opens beside its anchor, clamps on resize, marks the active filter, and selects one', async () => {
    const onSelect = vi.fn()
    render(
      <div>
        <FilterHistoryDropdown
          history={['id = 1', 'name LIKE \'A%\'']}
          activeFilter="id = 1"
          onSelect={onSelect}
        />
        <div data-testid="editor-anchor" />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: 'Recent filters' })
    trigger.getBoundingClientRect = () => rect(20, 10, 40, 24)
    screen.getByTestId('editor-anchor').getBoundingClientRect = () => rect(900, 10, 600, 24)

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Recent filters' })
    expect(menu).toHaveStyle({ left: '392px', top: '38px', width: '600px' })
    expect(screen.getByRole('menuitem', { name: 'id = 1' })).toHaveAttribute('aria-current', 'true')

    screen.getByTestId('editor-anchor').getBoundingClientRect = () => rect(20, 10, 300, 24)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(menu).toHaveStyle({ left: '20px', width: '300px' })

    fireEvent.click(screen.getByRole('menuitem', { name: 'name LIKE \'A%\'' }))
    expect(onSelect).toHaveBeenCalledWith('name LIKE \'A%\'')
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Recent filters' })).not.toBeInTheDocument())
  })

  it('uses the trigger rect as the width when there is no sibling anchor', async () => {
    render(<FilterHistoryDropdown history={['id = 1']} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Recent filters' })
    trigger.getBoundingClientRect = () => rect(30, 12, 440, 20)

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Recent filters' })
    expect(menu).toHaveStyle({ left: '30px', top: '36px', width: '440px' })
  })

  it('survives a missing layout box while open and ignores clicks inside itself or on its trigger', async () => {
    render(
      <div>
        <FilterHistoryDropdown history={['id = 1']} onSelect={vi.fn()} />
        <div data-testid="editor-anchor" />
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Recent filters' })
    trigger.getBoundingClientRect = () => rect(20, 10, 40, 24)
    const anchor = screen.getByTestId('editor-anchor')
    anchor.getBoundingClientRect = () => rect(20, 10, 300, 24)

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Recent filters' })
    expect(menu).toHaveStyle({ left: '20px', width: '300px' })

    fireEvent.mouseDown(menu)
    expect(screen.getByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()

    anchor.getBoundingClientRect = () => null as unknown as DOMRect
    trigger.getBoundingClientRect = () => null as unknown as DOMRect
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()

    fireEvent.mouseDown(trigger)
    expect(screen.getByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()
  })

  it('closes on an outside click and toggles closed from the trigger', async () => {
    render(<FilterHistoryDropdown history={['id = 1']} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Recent filters' })
    trigger.getBoundingClientRect = () => rect(20, 10, 40, 24)

    fireEvent.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Recent filters' })).not.toBeInTheDocument())

    fireEvent.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Recent filters' })).not.toBeInTheDocument())
  })

  it('closes from the shared menu keyboard handler', async () => {
    render(<FilterHistoryDropdown history={['id = 1']} onSelect={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Recent filters' })
    trigger.getBoundingClientRect = () => rect(20, 10, 40, 24)

    fireEvent.click(trigger)
    expect(await screen.findByRole('menu', { name: 'Recent filters' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Recent filters' })).not.toBeInTheDocument())
  })
})
