import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TabBar from '../../components/layout/TabBar'
import { useTabStore } from '../../store/tabStore'
import { useSessionStore } from '../../store/sessionStore'
import { useServerConfigStore } from '../../store/serverConfigStore'
import type { Tab } from '../../types'

function tab(patch: Partial<Tab> & Pick<Tab, 'id'>): Tab {
  return {
    type: 'query',
    label: patch.id,
    sessionId: 'session-1',
    ...patch,
  } as Tab
}

function rect(left: number, width: number): DOMRect {
  return new DOMRect(left, 0, width, 40)
}

describe('TabBar coverage', () => {
  const query1 = tab({ id: 'query-1', label: 'Query one', database: 'app_db' })
  const query2 = tab({ id: 'query-2', label: 'Query two' })
  const table1 = tab({
    id: 'table-1',
    type: 'table',
    label: 'customers',
    database: 'app_db',
    table: 'customers',
  })

  beforeEach(() => {
    localStorage.clear()
    useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
    useSessionStore.setState({ activeSessionId: null, sessions: [] })
    useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('renders an empty bar, opens a query for the active connection, and exposes admin', () => {
    const onOpenAdmin = vi.fn()
    const view = render(<TabBar onOpenAdmin={onOpenAdmin} />)

    expect(screen.queryByRole('button', { name: 'New Query' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close All' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Admin console' })).not.toBeInTheDocument()

    act(() => useSessionStore.setState({ activeSessionId: 'session-1' }))
    fireEvent.click(screen.getByRole('button', { name: /New Query/ }))

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      type: 'query',
      sessionId: 'session-1',
    })
    expect(screen.getByRole('button', { name: 'Close All' })).toBeInTheDocument()

    act(() => useServerConfigStore.setState({ ldapEnabled: true, isAdmin: false }))
    expect(screen.queryByRole('button', { name: 'Admin console' })).not.toBeInTheDocument()
    act(() => useServerConfigStore.setState({ isAdmin: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Admin console' }))
    expect(onOpenAdmin).toHaveBeenCalledOnce()

    act(() => useServerConfigStore.setState({ ldapEnabled: false, isAdmin: true }))
    expect(screen.queryByRole('button', { name: 'Admin console' })).not.toBeInTheDocument()
    view.unmount()
  })

  it('renders query and table titles, database labels, and dirty markers', () => {
    const tableNoDb = tab({
      id: 'table-no-db',
      type: 'table',
      label: 'Standalone',
      database: '',
      table: undefined,
    })
    const tableDbNoName = tab({
      id: 'table-db-no-name',
      type: 'table',
      label: 'Label only',
      database: 'app_db',
      table: undefined,
    })
    useTabStore.setState({
      tabs: [query1, query2, table1, tableNoDb, tableDbNoName],
      activeTabId: 'table-1',
    })

    render(<TabBar />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(5)
    expect(screen.getByRole('tab', { name: /Query one/ })).toHaveAttribute(
      'title',
      'Query tab for app_db',
    )
    expect(screen.getByRole('tab', { name: /Query two/ })).toHaveAttribute(
      'title',
      'Query tab',
    )
    expect(screen.getByRole('tab', { name: /app_db customers/ })).toHaveAttribute(
      'title',
      'Table tab for app_db.customers',
    )
    expect(screen.getByRole('tab', { name: 'Standalone' })).toHaveAttribute(
      'title',
      'Table tab for Standalone',
    )
    expect(screen.getByRole('tab', { name: /app_db Label only/ })).toHaveAttribute(
      'title',
      'Table tab for app_db.Label only',
    )
    expect(screen.getByRole('tab', { name: /app_db customers/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: /Query one/ })).toHaveAttribute(
      'aria-selected',
      'false',
    )

    act(() => {
      useTabStore.setState({
        tabs: [{ ...query1, dirty: true }, table1],
      })
    })
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument()
  })

  it('selects tabs with mouse and roving keyboard focus', () => {
    useTabStore.setState({
      tabs: [query1, query2, table1],
      activeTabId: query1.id,
    })
    render(<TabBar />)

    const first = screen.getByRole('tab', { name: /Query one/ })
    const second = screen.getByRole('tab', { name: /Query two/ })
    const third = screen.getByRole('tab', { name: /app_db customers/ })

    fireEvent.mouseDown(first, { button: 0 })
    fireEvent.click(second)
    expect(useTabStore.getState().activeTabId).toBe(second.id.replace('tab-', ''))
    expect(second).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(second, { key: 'ArrowRight' })
    expect(useTabStore.getState().activeTabId).toBe('table-1')
    expect(third).toHaveFocus()

    fireEvent.keyDown(third, { key: 'ArrowLeft' })
    expect(useTabStore.getState().activeTabId).toBe('query-2')

    fireEvent.keyDown(second, { key: 'Home' })
    expect(useTabStore.getState().activeTabId).toBe('query-1')

    fireEvent.keyDown(first, { key: 'End' })
    expect(useTabStore.getState().activeTabId).toBe('table-1')

    fireEvent.keyDown(third, { key: 'x' })
    expect(useTabStore.getState().activeTabId).toBe('table-1')
  })

  it('scrolls an active tab into view from both edges and leaves a visible tab alone', () => {
    useTabStore.setState({
      tabs: [query1, query2],
      activeTabId: query2.id,
    })
    const view = render(<TabBar />)
    const tabList = screen.getByRole('tablist')
    const first = screen.getByRole('tab', { name: /Query one/ })
    const second = screen.getByRole('tab', { name: /Query two/ })
    vi.spyOn(tabList, 'getBoundingClientRect').mockReturnValue(rect(0, 200))
    vi.spyOn(first.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(-20, 100))
    vi.spyOn(second.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(160, 100))

    tabList.scrollLeft = 20
    fireEvent.click(first)
    expect(tabList.scrollLeft).toBe(0)

    tabList.scrollLeft = 20
    fireEvent.click(second)
    expect(tabList.scrollLeft).toBe(80)

    vi.spyOn(first.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(40, 100))
    vi.spyOn(second.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(40, 100))
    act(() => useTabStore.setState({ activeTabId: query1.id }))
    vi.spyOn(first.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(40, 100))
    tabList.scrollLeft = 20
    act(() => useTabStore.setState({ tabs: [query1, query2, table1] }))
    expect(tabList.scrollLeft).toBe(20)
    view.unmount()
  })

  it('ignores active ids without a rendered tab', () => {
    useTabStore.setState({
      tabs: [query1],
      activeTabId: 'missing',
    })
    render(<TabBar />)
    expect(screen.getByRole('tab', { name: /Query one/ })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('closes a clean tab directly from its close button', () => {
    useTabStore.setState({
      tabs: [query1, table1],
      activeTabId: query1.id,
    })
    render(<TabBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close query tab for app_db' }))
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['table-1'])
    expect(useTabStore.getState().activeTabId).toBe('table-1')
  })

  it('reorders tabs by drag and drop and clears drag state at the edges', () => {
    useTabStore.setState({
      tabs: [query1, query2, table1],
      activeTabId: query1.id,
    })
    render(<TabBar />)
    const firstItem = screen.getByRole('tab', { name: /Query one/ }).parentElement!
    const secondItem = screen.getByRole('tab', { name: /Query two/ }).parentElement!
    const thirdItem = screen.getByRole('tab', { name: /app_db customers/ }).parentElement!
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    }

    fireEvent.dragStart(firstItem, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', query1.id)
    fireEvent.dragOver(thirdItem, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(thirdItem, { dataTransfer })
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual([
      'query-2',
      'table-1',
      'query-1',
    ])

    act(() => useTabStore.setState({ tabs: [query1, query2] }))
    fireEvent.dragStart(firstItem, { dataTransfer })
    fireEvent.drop(firstItem, { dataTransfer })
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['query-1', 'query-2'])

    fireEvent.dragStart(firstItem, { dataTransfer })
    fireEvent.dragEnd(firstItem, { dataTransfer })
    fireEvent.drop(secondItem, { dataTransfer })
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['query-1', 'query-2'])
  })

  it('renames query tabs, validates the name, and handles IME Enter', async () => {
    useTabStore.setState({
      tabs: [{ ...query1, label: 'Original' }],
      activeTabId: query1.id,
    })
    const user = userEvent.setup()
    render(<TabBar />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Original/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    let input = screen.getByRole('textbox', { name: 'Tab name' })
    expect(input).toHaveValue('Original')
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useTabStore.getState().tabs[0].label).toBe('Original')
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Original/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    input = screen.getByRole('textbox', { name: 'Tab name' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('dialog', { name: 'Rename Tab' })).toBeInTheDocument()
    expect(useTabStore.getState().tabs[0].label).toBe('Original')

    fireEvent.keyDown(input, { key: 'a' })
    expect(screen.getByRole('dialog', { name: 'Rename Tab' })).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useTabStore.getState().tabs[0].label).toBe('Renamed')
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Renamed/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Renamed/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await user.click(screen.getByLabelText('Close dialog'))
    expect(screen.queryByRole('dialog', { name: 'Rename Tab' })).not.toBeInTheDocument()
  })

  it('supports table context menus and dismisses menus by outside click and Escape', () => {
    useTabStore.setState({
      tabs: [table1, query2],
      activeTabId: table1.id,
    })
    render(<TabBar />)
    const tableTab = screen.getByRole('tab', { name: /app_db customers/ })

    fireEvent.contextMenu(tableTab, { clientX: 10, clientY: 10 })
    let menu = screen.getByRole('menu', { name: 'Tab actions' })
    expect(within(menu).queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument()
    expect(menu.querySelector('[role="separator"]')).not.toBeInTheDocument()
    fireEvent.click(document.body)
    expect(screen.queryByRole('menu', { name: 'Tab actions' })).not.toBeInTheDocument()

    fireEvent.contextMenu(tableTab, { clientX: 5000, clientY: 5000 })
    menu = screen.getByRole('menu', { name: 'Tab actions' })
    const floating = menu.parentElement!
    expect(floating.style.left).toBe(`${window.innerWidth - floating.offsetWidth - 8}px`)
    expect(floating.style.top).toBe(`${window.innerHeight - floating.offsetHeight - 8}px`)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Tab actions' })).not.toBeInTheDocument()

    fireEvent.contextMenu(tableTab, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }))
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['query-2'])
  })

  it('hides a context menu whose tab disappears', () => {
    useTabStore.setState({
      tabs: [query1],
      activeTabId: query1.id,
    })
    render(<TabBar />)

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Query one/ }))
    expect(screen.getByRole('menu', { name: 'Tab actions' })).toBeInTheDocument()
    act(() => useTabStore.setState({ tabs: [] }))
    expect(screen.queryByRole('menu', { name: 'Tab actions' })).not.toBeInTheDocument()
  })

  it('confirms before closing a dirty tab and supports cancel', async () => {
    useTabStore.setState({
      tabs: [{ ...query1, dirty: true }, query2],
      activeTabId: query1.id,
    })
    const user = userEvent.setup()
    render(<TabBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close query tab for app_db' }))
    expect(screen.getByRole('alertdialog', { name: 'Close Tab' })).toBeInTheDocument()
    expect(screen.getByText(/Unsaved editor text or table changes/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useTabStore.getState().tabs).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Close query tab for app_db' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['query-2'])
  })

  it('closes all clean tabs immediately without a prompt', () => {
    useTabStore.setState({
      tabs: [query1, query2],
      activeTabId: query1.id,
    })
    render(<TabBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))
    expect(useTabStore.getState().tabs).toEqual([])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('confirms closing all tabs when dirty and renders singular and plural warnings', async () => {
    useTabStore.setState({
      tabs: [{ ...query1, dirty: true }],
      activeTabId: query1.id,
    })
    const user = userEvent.setup()
    const view = render(<TabBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))
    expect(screen.getByRole('alertdialog', { name: 'Close All Tabs' })).toBeInTheDocument()
    expect(screen.getByText(/Close all 1 open tab\?/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useTabStore.getState().tabs).toHaveLength(1)

    act(() => useTabStore.setState({ tabs: [{ ...query1, dirty: true }, query2] }))
    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))
    expect(screen.getByText(/Close all 2 open tabs\?/)).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Close All Tabs' }))
        .getByRole('button', { name: 'Close All' }),
    )
    expect(useTabStore.getState().tabs).toEqual([])
    view.unmount()
  })

  it('confirms closing all tabs in an authenticated session', async () => {
    useServerConfigStore.setState({ ldapEnabled: true })
    useTabStore.setState({
      tabs: [query1, query2],
      activeTabId: query1.id,
    })
    const user = userEvent.setup()
    render(<TabBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))
    expect(screen.getByText(/in this authenticated session\?/)).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Close All Tabs' }))
        .getByRole('button', { name: 'Close All' }),
    )
    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('dismisses the close-all prompt and ignores context-menu mousedown defaults', async () => {
    useTabStore.setState({
      tabs: [{ ...query1, dirty: true }],
      activeTabId: query1.id,
    })
    const user = userEvent.setup()
    render(<TabBar />)

    const tabButton = screen.getByRole('tab', { name: /Query one/ })
    expect(fireEvent.mouseDown(tabButton, { button: 2 })).toBe(false)
    fireEvent.contextMenu(tabButton, { clientX: 20, clientY: 20 })
    fireEvent.mouseDown(screen.getByRole('menu', { name: 'Tab actions' }), { button: 2 })

    fireEvent.click(screen.getByRole('button', { name: 'Close All' }))
    await user.click(screen.getByLabelText('Close dialog'))
    expect(screen.queryByRole('alertdialog', { name: 'Close All Tabs' })).not.toBeInTheDocument()
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })
})
