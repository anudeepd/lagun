import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import PresenceReporter from '../../components/presence/PresenceReporter'
import { api } from '../../api/client'
import { useTabStore } from '../../store/tabStore'

vi.mock('../../api/client', () => ({
  api: {
    reportPresence: vi.fn().mockResolvedValue({ ok: true }),
    deletePresence: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../../utils/randomId', () => ({
  randomId: vi.fn(() => 'random-token'),
}))

const reportPresence = vi.mocked(api.reportPresence)
const deletePresence = vi.mocked(api.deletePresence)

async function flushPresence() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  await Promise.resolve()
}

describe('PresenceReporter behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    reportPresence.mockResolvedValue({ ok: true })
    deletePresence.mockResolvedValue({ ok: true })
    sessionStorage.clear()
    useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('reuses the stored client id and omits SQL from query presence', async () => {
    sessionStorage.setItem('lagun-presence-client-id', 'client-existing')
    useTabStore.setState({
      tabs: [{
        id: 'query-1',
        type: 'query',
        label: 'Query',
        sessionId: 'session-1',
        database: 'analytics',
        sql: 'SELECT secret FROM users',
      }],
      activeTabId: 'query-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)
    await flushPresence()

    expect(reportPresence).toHaveBeenCalledWith({
      client_id: 'client-existing',
      active_tab_id: 'query-1',
      tabs: [{
        id: 'query-1',
        type: 'query',
        label: 'Query',
        session_id: 'session-1',
        database: 'analytics',
        table: null,
      }],
    })
    expect(JSON.stringify(reportPresence.mock.calls[0][0])).not.toContain('secret')
  })

  it('creates and stores a stable client id when none exists', async () => {
    render(<PresenceReporter />)
    await flushPresence()

    expect(reportPresence.mock.calls[0][0].client_id).toBe('client-random-token')
    expect(sessionStorage.getItem('lagun-presence-client-id')).toBe('client-random-token')
  })

  it('falls back to an in-memory id when session storage throws', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => undefined,
    })

    render(<PresenceReporter />)
    await flushPresence()

    expect(reportPresence.mock.calls[0][0].client_id).toBe('client-random-token')
  })

  it('clamps every bounded tab field and defaults table context', async () => {
    useTabStore.setState({
      tabs: [{
        id: 'table-1',
        type: 'table',
        label: '   ',
        sessionId: 'session-1',
        database: ` ${'D'.repeat(140)} `,
        table: ` ${'T'.repeat(140)} `,
        dataState: {
          view: ` ${'V'.repeat(40)} ` as unknown as 'data',
          globalSearch: ' '.repeat(3) + 'g'.repeat(1_100),
          appliedWhere: 'w'.repeat(33_000),
          limit: 0,
        },
      }, {
        id: 'table-2',
        type: 'table',
        label: 'Fallback view',
        sessionId: 'session-1',
        dataState: { view: '   ' as unknown as 'data' },
      }],
      activeTabId: 'table-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)
    await flushPresence()

    const tab = reportPresence.mock.calls[0][0].tabs[0]
    expect(tab.label).toBe('')
    expect(tab.database).toHaveLength(128)
    expect(tab.table).toHaveLength(128)
    expect(tab.view).toHaveLength(32)
    expect(tab.global_search).toHaveLength(1_000)
    expect(tab.where_filter).toHaveLength(32_000)
    expect(tab.row_limit).toBe(0)
    expect(reportPresence.mock.calls[0][0].tabs[1].view).toBe('schema')
  })

  it('defaults missing table context and caps the published tab list', async () => {
    useTabStore.setState({
      tabs: Array.from({ length: 120 }, (_, index) => ({
        id: `tab-${index}`,
        type: index === 0 ? 'table' as const : 'query' as const,
        label: `Tab ${index}`,
        sessionId: 'session-1',
      })),
      activeTabId: 'tab-0',
      pendingSqls: {},
    })

    render(<PresenceReporter />)
    await flushPresence()

    const payload = reportPresence.mock.calls[0][0]
    expect(payload.tabs).toHaveLength(100)
    expect(payload.tabs[0]).toMatchObject({
      database: null,
      table: null,
      view: 'schema',
      global_search: null,
      where_filter: null,
      row_limit: 1000,
    })
  })

  it('logs only the first background failure and never toasts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportPresence
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce('still offline')
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)
    await flushPresence()
    expect(warn).toHaveBeenCalledWith('Could not publish presence: offline')

    act(() => useTabStore.setState({ activeTabId: null }))
    await flushPresence()
    expect(reportPresence).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('logs a non-Error failure as text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportPresence.mockRejectedValueOnce('gateway down')
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
      pendingSqls: {},
    })

    render(<PresenceReporter />)
    await flushPresence()

    expect(warn).toHaveBeenCalledWith('Could not publish presence: gateway down')
  })

  it('heartbeats while mounted and stops after unmount', async () => {
    const view = render(<PresenceReporter />)
    await flushPresence()
    expect(reportPresence).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(reportPresence).toHaveBeenCalledTimes(2)

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(reportPresence).toHaveBeenCalledTimes(2)
    expect(deletePresence).toHaveBeenCalledWith(reportPresence.mock.calls[0][0].client_id)
  })

  it('swallows a failed presence delete during cleanup', async () => {
    deletePresence.mockRejectedValueOnce(new Error('offline'))
    const view = render(<PresenceReporter />)
    await flushPresence()

    view.unmount()
    await Promise.resolve()
    expect(deletePresence).toHaveBeenCalledOnce()
  })

  it('does not send when a captured timeout fires after unmount', async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = []
    vi.spyOn(window, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') {
        scheduled.push({ callback: callback as () => void, delay: delay ?? 0 })
      }
      return 1
    }) as typeof window.setTimeout)
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined)

    const view = render(<PresenceReporter />)
    view.unmount()
    act(() => scheduled.find(entry => entry.delay === 150)?.callback())

    expect(reportPresence).not.toHaveBeenCalled()
  })
})
