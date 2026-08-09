import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import PresenceReporter from '../../components/presence/PresenceReporter'
import { useTabStore } from '../../store/tabStore'

vi.mock('../../api/client', () => ({
  api: {
    reportPresence: vi.fn().mockResolvedValue({ ok: true }),
    deletePresence: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

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
})
