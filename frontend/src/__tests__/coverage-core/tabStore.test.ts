import { beforeEach, describe, expect, it } from 'vitest'
import { useTabStore } from '../../store/tabStore'
import type { Tab } from '../../types'

function reset() {
  localStorage.clear()
  useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
}

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return { id, label: id, type: 'query', sessionId: 'session-1', ...overrides }
}

beforeEach(reset)

describe('tab store creation', () => {
  it('opens a query tab with and without a database context', () => {
    const store = useTabStore.getState()
    store.openQueryTab('session-1')
    store.openQueryTab('session-1', 'analytics')

    const { tabs, activeTabId } = useTabStore.getState()
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toMatchObject({
      type: 'query',
      sessionId: 'session-1',
      label: 'Query',
      database: undefined,
    })
    expect(tabs[1]).toMatchObject({
      type: 'query',
      sessionId: 'session-1',
      label: 'Query — analytics',
      database: 'analytics',
    })
    expect(activeTabId).toBe(tabs[1].id)
  })

  it('opens a query tab with initial SQL in the requested database', () => {
    useTabStore.getState().openQueryTabWithSql('session-1', 'SELECT 1', 'app')

    expect(useTabStore.getState().tabs[0]).toMatchObject({
      label: 'Query — app',
      database: 'app',
      sql: 'SELECT 1',
    })
  })

  it('opens SQL without a database label', () => {
    useTabStore.getState().openQueryTabWithSql('session-1', 'SELECT 2')

    expect(useTabStore.getState().tabs[0]).toMatchObject({
      label: 'Query',
      database: undefined,
      sql: 'SELECT 2',
    })
  })

  it('reuses an existing table tab instead of opening a duplicate', () => {
    const store = useTabStore.getState()
    store.openTableTab('session-1', 'app', 'users')
    const first = useTabStore.getState().tabs[0]
    store.openQueryTab('session-1')
    store.openTableTab('session-1', 'app', 'users')

    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe(first.id)
  })

  it('opens table tabs for distinct tables', () => {
    const store = useTabStore.getState()
    store.openTableTab('session-1', 'app', 'users')
    store.openTableTab('session-1', 'app', 'orders')

    expect(useTabStore.getState().tabs.map(item => item.label)).toEqual(['users', 'orders'])
  })
})

describe('tab store lifecycle', () => {
  it('selects the previous tab after closing the active middle tab', () => {
    useTabStore.setState({
      tabs: [tab('one'), tab('two'), tab('three')],
      activeTabId: 'two',
    })

    useTabStore.getState().closeTab('two')

    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['one', 'three'])
    expect(useTabStore.getState().activeTabId).toBe('one')
  })

  it('selects the next remaining tab after closing the active first tab', () => {
    useTabStore.setState({ tabs: [tab('one'), tab('two')], activeTabId: 'one' })

    useTabStore.getState().closeTab('one')

    expect(useTabStore.getState().activeTabId).toBe('two')
  })

  it('keeps the active tab when closing a background tab', () => {
    useTabStore.setState({ tabs: [tab('one'), tab('two')], activeTabId: 'one' })

    useTabStore.getState().closeTab('two')
    useTabStore.getState().closeTab('missing')

    expect(useTabStore.getState().activeTabId).toBe('one')
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['one'])
  })

  it('sets and clears the active tab and closes all tabs', () => {
    useTabStore.setState({ tabs: [tab('one')] })
    useTabStore.getState().setActiveTab('one')
    expect(useTabStore.getState().activeTabId).toBe('one')

    useTabStore.getState().closeAllTabs()
    expect(useTabStore.getState()).toMatchObject({ tabs: [], activeTabId: null })
  })

  it('reorders tabs when both endpoints exist', () => {
    useTabStore.setState({ tabs: [tab('one'), tab('two'), tab('three')] })
    useTabStore.getState().moveTab('three', 'one')
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['three', 'one', 'two'])

    useTabStore.getState().moveTab('missing', 'one')
    useTabStore.getState().moveTab('one', 'missing')
    expect(useTabStore.getState().tabs.map(item => item.id)).toEqual(['three', 'one', 'two'])
  })
})

describe('tab store mutations', () => {
  it('updates SQL only on the addressed tab', () => {
    useTabStore.setState({ tabs: [tab('one'), tab('two')] })
    useTabStore.getState().setSql('two', 'SELECT 2')

    const [first, second] = useTabStore.getState().tabs
    expect(first.sql).toBeUndefined()
    expect(second.sql).toBe('SELECT 2')
  })

  it('changes the database label only on the addressed tab', () => {
    useTabStore.setState({ tabs: [tab('one'), tab('two', { database: 'old' })] })
    useTabStore.getState().setTabDatabase('two', 'analytics')

    expect(useTabStore.getState().tabs[1]).toMatchObject({
      database: 'analytics',
      label: 'Query — analytics',
    })
    expect(useTabStore.getState().tabs[0].label).toBe('one')
  })

  it('merges data state only into table tabs', () => {
    useTabStore.setState({
      tabs: [
        tab('query'),
        tab('table', { type: 'table', table: 'users', dataState: { view: 'schema' } }),
      ],
    })
    useTabStore.getState().setTableDataState('table', { view: 'data', limit: 500 })
    useTabStore.getState().setTableDataState('query', { view: 'data' })
    useTabStore.getState().setTableDataState('missing', { view: 'data' })

    expect(useTabStore.getState().tabs[1].dataState).toEqual({ view: 'data', limit: 500 })
    expect(useTabStore.getState().tabs[0].dataState).toBeUndefined()
  })

  it('queues and consumes SQL for one tab', () => {
    useTabStore.getState().injectSqlToTab('one', 'SELECT 1', 'app')
    useTabStore.getState().injectSqlToTab('two', 'SELECT 2')

    expect(useTabStore.getState().pendingSqls).toEqual({
      one: { sql: 'SELECT 1', database: 'app' },
      two: { sql: 'SELECT 2', database: undefined },
    })

    useTabStore.getState().consumePendingSql('one')
    expect(useTabStore.getState().pendingSqls).toEqual({
      two: { sql: 'SELECT 2', database: undefined },
    })
    useTabStore.getState().consumePendingSql('missing')
    expect(useTabStore.getState().pendingSqls).toHaveProperty('two')
  })

  it('renames only query tabs and tracks dirty state', () => {
    useTabStore.setState({
      tabs: [
        tab('query'),
        tab('table', { type: 'table', table: 'users' }),
      ],
    })
    useTabStore.getState().renameTab('query', 'Renamed')
    useTabStore.getState().renameTab('table', 'Not renamed')
    useTabStore.getState().setTabDirty('query', true)
    useTabStore.getState().setTabDirty('missing', true)

    const [query, table] = useTabStore.getState().tabs
    expect(query).toMatchObject({ label: 'Renamed', dirty: true })
    expect(table.label).toBe('table')
    expect(table.dirty).toBeUndefined()
  })

  it('persists only tabs and the active tab', () => {
    useTabStore.setState({ tabs: [tab('one')], activeTabId: 'one', pendingSqls: { one: { sql: 'x' } } })
    const partialize = useTabStore.persist.getOptions().partialize

    expect(partialize?.(useTabStore.getState())).toEqual({
      tabs: [tab('one')],
      activeTabId: 'one',
    })
  })
})
