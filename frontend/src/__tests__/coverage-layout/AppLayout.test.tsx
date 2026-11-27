import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import AppLayout from '../../components/layout/AppLayout'
import { useTabStore } from '../../store/tabStore'
import type { Tab } from '../../types'

vi.mock('../../components/layout/Sidebar', () => ({
  default: () => (
    <div data-testid="sidebar">
      <button type="button">First sidebar control</button>
      <button type="button">Last sidebar control</button>
    </div>
  ),
}))

vi.mock('../../components/layout/TabBar', () => ({
  default: ({ onOpenAdmin }: { onOpenAdmin?: () => void }) => (
    <div data-testid="tab-bar">
      <button type="button" onClick={() => onOpenAdmin?.()}>Open admin</button>
    </div>
  ),
}))

vi.mock('../../components/editor/TabContent', () => ({
  default: ({ tab, active }: { tab: Tab; active: boolean }) => (
    <div data-testid={`tab-content-${tab.id}`} data-active={String(active)}>{tab.label}</div>
  ),
}))

vi.mock('../../components/layout/QueryLogPanel', () => ({
  default: () => <div data-testid="query-log">Query log stub</div>,
}))

vi.mock('../../components/ui/CommandPalette', () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="command-palette" data-open={String(open)}>
      <button type="button" onClick={onClose}>close command palette</button>
    </div>
  ),
}))

vi.mock('../../components/ui/ShortcutHelpDialog', () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="shortcut-help" data-open={String(open)}>
      <button type="button" onClick={onClose}>close shortcut help</button>
    </div>
  ),
}))

interface MediaController {
  matches: boolean
  fire: () => void
}

function installMediaQuery(): MediaController {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const controller: MediaController = {
    matches: false,
    fire: () => {
      const event = { matches: controller.matches } as MediaQueryListEvent
      listeners.forEach(listener => listener(event))
    },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return controller.matches },
    media: '(min-width: 1024px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })))
  return controller
}

describe('AppLayout coverage', () => {
  let media: MediaController

  beforeEach(() => {
    localStorage.clear()
    media = installMediaQuery()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the default width and persists keyboard resizing within bounds', () => {
    render(<AppLayout />)
    const separator = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(separator).toHaveAttribute('aria-valuenow', '256')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '272')
    expect(localStorage.getItem('lagun-sidebar-width')).toBe('272')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '256')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '160')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '160')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '520')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '520')

    fireEvent.keyDown(separator, { key: 'PageDown' })
    expect(separator).toHaveAttribute('aria-valuenow', '520')
  })

  it('restores a saved width and resizes by dragging the separator', () => {
    localStorage.setItem('lagun-sidebar-width', '300')
    render(<AppLayout />)
    const separator = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(separator).toHaveAttribute('aria-valuenow', '300')
    fireEvent.mouseDown(separator, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 220 })
    expect(separator).toHaveAttribute('aria-valuenow', '420')
    expect(localStorage.getItem('lagun-sidebar-width')).toBe('420')

    fireEvent.mouseMove(document, { clientX: 1000 })
    expect(separator).toHaveAttribute('aria-valuenow', '520')

    fireEvent.mouseMove(document, { clientX: -1000 })
    expect(separator).toHaveAttribute('aria-valuenow', '160')

    fireEvent.mouseUp(document)
    fireEvent.mouseMove(document, { clientX: 400 })
    expect(separator).toHaveAttribute('aria-valuenow', '160')
  })

  it('traps focus in the mobile drawer and closes it from the overlay', () => {
    render(<AppLayout />)
    const open = screen.getByRole('button', { name: 'Open navigation' })
    fireEvent.click(open)

    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    const first = screen.getByRole('button', { name: 'First sidebar control' })
    const last = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(window, { key: 'x' })
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument()
    expect(open).toHaveFocus()
  })

  it('closes the mobile drawer with Escape and on the desktop breakpoint', () => {
    render(<AppLayout />)
    const open = screen.getByRole('button', { name: 'Open navigation' })

    fireEvent.click(open)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument()
    expect(open).toHaveFocus()

    fireEvent.click(open)
    act(() => {
      media.matches = false
      media.fire()
    })
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument()

    act(() => {
      media.matches = true
      media.fire()
    })
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument()
  })

  it('toggles the command palette by keyboard and the mobile toolbar', () => {
    render(<AppLayout />)
    const palette = screen.getByTestId('command-palette')

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(palette).toHaveAttribute('data-open', 'true')
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true })
    expect(palette).toHaveAttribute('data-open', 'false')
    fireEvent.keyDown(window, { key: 'K' })
    expect(palette).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(palette).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close command palette' }))
    expect(palette).toHaveAttribute('data-open', 'false')
  })

  it('opens shortcut help only when typing is not focused', () => {
    render(<AppLayout />)
    const help = screen.getByTestId('shortcut-help')

    const blocked = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      document.createElement('div'),
    ]
    Object.defineProperty(blocked[3], 'isContentEditable', { value: true })
    blocked.forEach(element => {
      document.body.appendChild(element)
      fireEvent.keyDown(element, { key: '?' })
      expect(help).toHaveAttribute('data-open', 'false')
      element.remove()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const ordinary = document.createElement('div')
    document.body.appendChild(ordinary)
    fireEvent.keyDown(ordinary, { key: '?' })
    expect(help).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close shortcut help' }))
    ordinary.remove()

    fireEvent.keyDown(document.body, { key: '?' })
    expect(help).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close shortcut help' }))
    expect(help).toHaveAttribute('data-open', 'false')
  })

  it('renders the empty workspace until tabs open', () => {
    const view = render(<AppLayout />)
    expect(
      screen.getByText('Select a table from the sidebar or open a query tab'),
    ).toBeInTheDocument()

    const tabs: Tab[] = [
      { id: 'query-1', type: 'query', label: 'Query one', sessionId: 'session-1' },
      {
        id: 'table-1',
        type: 'table',
        label: 'users',
        sessionId: 'session-1',
        database: 'app_db',
        table: 'users',
      },
    ]
    act(() => useTabStore.setState({ tabs, activeTabId: 'table-1' }))
    view.rerender(<AppLayout />)

    expect(
      screen.queryByText('Select a table from the sidebar or open a query tab'),
    ).not.toBeInTheDocument()
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'))
    expect(panels).toHaveLength(2)

    const queryPanel = document.getElementById('tab-panel-query-1')!
    const tablePanel = document.getElementById('tab-panel-table-1')!
    expect(queryPanel).toHaveAttribute('aria-hidden', 'true')
    expect(queryPanel).toHaveProperty('inert', true)
    expect(tablePanel).not.toHaveAttribute('aria-hidden')
    expect(tablePanel).toHaveProperty('inert', false)
    expect(within(queryPanel).getByTestId('tab-content-query-1')).toHaveAttribute(
      'data-active',
      'false',
    )
    expect(within(tablePanel).getByTestId('tab-content-table-1')).toHaveAttribute(
      'data-active',
      'true',
    )
  })

  it('passes the admin navigation callback to the tab bar', () => {
    const navigateToAdmin = vi.fn()
    render(<AppLayout navigateToAdmin={navigateToAdmin} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open admin' }))
    expect(navigateToAdmin).toHaveBeenCalledOnce()
  })

  it('clears modal and panel focus state when unmounted', () => {
    useTabStore.setState({
      tabs: [{ id: 'query-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'query-1',
    })
    const view = render(<AppLayout />)
    const panel = document.getElementById('tab-panel-query-1')!
    expect(panel).toHaveProperty('inert', false)

    view.unmount()
    expect(panel).toHaveProperty('inert', false)
  })
})
