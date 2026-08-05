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
})
