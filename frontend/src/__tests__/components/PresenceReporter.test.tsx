import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import PresenceReporter from '../../components/presence/PresenceReporter'
import { useTabStore } from '../../store/tabStore'
import { showToast } from '../../utils/toast'

vi.mock('../../api/client', () => ({
  api: {
    reportPresence: vi.fn().mockResolvedValue({ ok: true }),
    deletePresence: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))

afterEach(() => {
  cleanup()
  useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('PresenceReporter', () => {
  it('publishes active tab identity without SQL text', async () => {
    useTabStore.setState({
      tabs: [{
        id: 'tab-1',
        type: 'query',
        label: 'Query — analytics',
        sessionId: 'session-1',
        database: 'analytics',
        sql: 'SELECT secret_column FROM users',
      }],
      activeTabId: 'tab-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)

    await waitFor(() => expect(api.reportPresence).toHaveBeenCalled())
    expect(api.reportPresence).toHaveBeenCalledWith(expect.objectContaining({
      active_tab_id: 'tab-1',
      tabs: [{
        id: 'tab-1',
        type: 'query',
        label: 'Query — analytics',
        session_id: 'session-1',
        database: 'analytics',
        table: null,
      }],
    }))
    expect(JSON.stringify(vi.mocked(api.reportPresence).mock.calls[0][0])).not.toContain('secret_column')
  })

  it('publishes applied live table search and browsing context', async () => {
    useTabStore.setState({
      tabs: [{
        id: 'table-1',
        type: 'table',
        label: 'orders',
        sessionId: 'session-1',
        database: 'analytics',
        table: 'orders',
        dataState: {
          view: 'data',
          globalSearch: 'alice@example.test',
          whereFilter: 'draft_filter = true',
          appliedWhere: "status = 'open' AND total >= 250",
          limit: 250,
        },
      }],
      activeTabId: 'table-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)

    await waitFor(() => expect(api.reportPresence).toHaveBeenCalled())
    expect(api.reportPresence).toHaveBeenCalledWith(expect.objectContaining({
      active_tab_id: 'table-1',
      tabs: [{
        id: 'table-1',
        type: 'table',
        label: 'orders',
        session_id: 'session-1',
        database: 'analytics',
        table: 'orders',
        view: 'data',
        global_search: 'alice@example.test',
        where_filter: "status = 'open' AND total >= 250",
        row_limit: 250,
      }],
    }))
    expect(JSON.stringify(vi.mocked(api.reportPresence).mock.calls[0][0])).not.toContain('draft_filter')
  })

  it('clamps every bounded field so an over-long tab cannot 422 the whole report', async () => {
    useTabStore.setState({
      tabs: [{
        id: 'tab-1',
        type: 'table',
        label: 'L'.repeat(500),
        sessionId: 'session-1',
        database: 'D'.repeat(300),
        table: 'T'.repeat(300),
        dataState: {
          view: 'data',
          globalSearch: 'g'.repeat(2_000),
          appliedWhere: 'w'.repeat(40_000),
          limit: 250,
        },
      }],
      activeTabId: 'tab-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)

    await waitFor(() => expect(api.reportPresence).toHaveBeenCalled())
    const tab = vi.mocked(api.reportPresence).mock.calls[0][0].tabs[0]
    expect(tab.label).toHaveLength(200)
    expect(tab.database).toHaveLength(128)
    expect(tab.table).toHaveLength(128)
    expect(tab.global_search).toHaveLength(1_000)
    expect(tab.where_filter).toHaveLength(32_000)
    expect(tab.view).toBe('data')
  })

  it('caps the published tab list at the 100 the API accepts', async () => {
    useTabStore.setState({
      tabs: Array.from({ length: 120 }, (_, index) => ({
        id: `tab-${index}`,
        type: 'query' as const,
        label: `Query ${index}`,
        sessionId: 'session-1',
      })),
      activeTabId: 'tab-0',
      pendingSqls: {},
    })

    render(<PresenceReporter />)

    await waitFor(() => expect(api.reportPresence).toHaveBeenCalled())
    expect(vi.mocked(api.reportPresence).mock.calls[0][0].tabs).toHaveLength(100)
  })

  it('surfaces the first publish failure and stays quiet on retries', async () => {
    vi.mocked(api.reportPresence).mockRejectedValue(new Error('503 Service Unavailable'))
    useTabStore.setState({
      tabs: [{
        id: 'tab-1',
        type: 'query',
        label: 'Query',
        sessionId: 'session-1',
      }],
      activeTabId: 'tab-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1))
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Could not publish presence: 503 Service Unavailable'),
      'error',
    )

    // A new payload restarts the heartbeat and fails again; the user has
    // already been told, so there is no second toast.
    act(() => useTabStore.setState({ activeTabId: null }))
    await waitFor(() => expect(api.reportPresence).toHaveBeenCalledTimes(2))
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})
