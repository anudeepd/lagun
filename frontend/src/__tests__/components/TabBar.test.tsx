import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TabBar from '../../components/layout/TabBar'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import { useServerConfigStore } from '../../store/serverConfigStore'

describe('TabBar', () => {

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ activeSessionId: null })
    useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
  })

  it('prevents the right-button press from selecting tab text', () => {
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)

    const tab = screen.getByRole('tab', { name: /query/i })
    expect(fireEvent.mouseDown(tab, { button: 2 })).toBe(false)
    fireEvent.contextMenu(tab)
    expect(screen.getByRole('menu', { name: 'Tab actions' }).querySelector('.border-t')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()
  })

  it('does not show the focus ring on a tab that holds mouse focus, but does for keyboard focus', () => {
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)
    const tab = screen.getByRole('tab', { name: /query/i })

    // Chromium focuses the pressed button; Shift is then held to scroll the
    // grid horizontally and made the tab's ring appear.
    fireEvent.mouseDown(tab, { button: 0 })
    act(() => tab.focus())
    expect(tab.className).not.toContain('focus-visible:ring-2')
    fireEvent.keyDown(tab, { key: 'Shift' })
    expect(tab.className).not.toContain('focus-visible:ring-2')

    // Any real keyboard use (here: tab-list navigation) restores the ring.
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    expect(tab.className).toContain('focus-visible:ring-2')

    // Focusing by keyboard later shows the ring from the start.
    act(() => tab.blur())
    act(() => tab.focus())
    expect(tab.className).toContain('focus-visible:ring-2')
  })

  it('scrolls a clipped active tab, including its close button, fully into view', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
    useTabStore.setState({
      tabs: [
        { id: 'tab-1', type: 'query', label: 'Query 1', sessionId: 'session-1' },
        { id: 'tab-2', type: 'query', label: 'Query 2', sessionId: 'session-1' },
      ],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)
    const tabList = screen.getByRole('tablist')
    const tab = screen.getByRole('tab', { name: /query 2/i })
    const item = tab.parentElement!
    vi.spyOn(tabList, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 0, 100, 40))
    tabList.scrollLeft = 20

    act(() => fireEvent.click(tab))

    expect(tabList.scrollLeft).toBe(80)
    frame.mockRestore()
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

  it('confirms Close All for clean tabs when LDAPGate is enabled', () => {
    useServerConfigStore.setState({ ldapEnabled: true })
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))

    expect(screen.getByRole('alertdialog', { name: 'Close All Tabs' })).toBeInTheDocument()
    expect(screen.getByText(/authenticated session/i)).toBeInTheDocument()
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })
})
