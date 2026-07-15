import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import TabBar from '../../components/layout/TabBar'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'

describe('TabBar', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ activeSessionId: null })
  })

  it('prevents the right-button press from selecting tab text', () => {
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)

    const tab = screen.getByRole('tab', { name: /query/i })
    expect(tab.parentElement).toHaveClass('select-none')
    expect(fireEvent.mouseDown(tab, { button: 2 })).toBe(false)
    fireEvent.contextMenu(tab)
    expect(screen.getByRole('menu', { name: 'Tab actions' }).querySelector('.border-t')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()
  })

  it('does not show a separator when Close is the only table-tab action', () => {
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'table', label: 'customers', database: 'lagun_demo', table: 'customers', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /customers/i }))
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByRole('menu', { name: 'Tab actions' }).querySelector('.border-t')).not.toBeInTheDocument()
  })
})
