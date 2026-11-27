import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import QueryLogPanel from '../../components/layout/QueryLogPanel'
import { useQueryLogStore, type QueryLogEntry } from '../../store/queryLogStore'
import { useTabStore } from '../../store/tabStore'
import { clipboardWrite } from '../../utils/clipboard'
import type { Tab } from '../../types'

vi.mock('../../utils/clipboard', () => ({
  clipboardWrite: vi.fn().mockResolvedValue(undefined),
}))

const base: QueryLogEntry = {
  id: 'entry-1',
  timestamp: '2026-01-02T03:04:05',
  sql: 'select 1',
  sessionId: 'session-1',
  execTimeMs: 4,
}

function entry(patch: Partial<QueryLogEntry>): QueryLogEntry {
  return { ...base, ...patch, id: patch.id ?? `${base.id}-${Math.random()}` }
}

describe('QueryLogPanel', () => {
  beforeEach(() => {
    useQueryLogStore.setState({ entries: [] })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.mocked(clipboardWrite).mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('starts collapsed with the empty log inert and expands on demand', () => {
    render(<QueryLogPanel />)
    const toggle = screen.getByRole('button', { name: /query log/i })
    const body = toggle.getAttribute('aria-controls')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(body!)).toHaveAttribute('aria-hidden', 'true')
    expect(document.getElementById(body!)).toHaveProperty('inert', true)
    expect(screen.getByText('No queries logged yet')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(body!)).not.toHaveAttribute('aria-hidden')
    expect(document.getElementById(body!)).toHaveProperty('inert', false)
  })

  it('renders the entry count, status variants, and row summaries', () => {
    useQueryLogStore.setState({
      entries: [
        entry({ id: 'cancelled', cancelled: true, error: undefined }),
        entry({ id: 'error', error: 'syntax error' }),
        entry({ id: 'affected', affectedRows: 2 }),
        entry({ id: 'rows', rowCount: 1 }),
        entry({ id: 'none', sql: 'select null' }),
        entry({
          id: 'bulk-rollback',
          bulk: {
            statementCount: 2,
            operationCounts: { UPDATE: 2 },
            rolledBack: true,
            fullSql: 'update t set x = 1',
          },
          affectedRows: 2,
        }),
        entry({
          id: 'bulk-count',
          bulk: {
            statementCount: 3,
            operationCounts: {},
            rolledBack: false,
            fullSql: 'insert into t values (1)',
          },
        }),
      ],
    })

    render(<QueryLogPanel />)
    expect(screen.getByText('7')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /query log/i }))

    expect(screen.getByTitle('syntax error')).toBeInTheDocument()
    expect(screen.getByTitle('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('2 affected')).toBeInTheDocument()
    expect(screen.getByText('1 row')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/Bulk write script: 2 statements/)).toBeInTheDocument()
    expect(screen.getByText('(2 UPDATE)')).toBeInTheDocument()
    expect(screen.getByText('rolled back, 2 affected')).toBeInTheDocument()
    expect(screen.getByText(/Bulk write script: 3 statements/)).toBeInTheDocument()
    expect(screen.getByText('3 stmts')).toBeInTheDocument()
  })

  it('copies replayable SQL and opens a query tab when none is active', async () => {
    useQueryLogStore.setState({
      entries: [
        entry({
          id: 'bulk',
          sql: 'update t set x = 1',
          database: 'app_db',
          bulk: {
            statementCount: 1,
            operationCounts: {},
            rolledBack: false,
            fullSql: 'update t set x = 1',
          },
        }),
      ],
    })
    const openQueryTabWithSql = vi.fn()
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      openQueryTabWithSql,
    })

    render(<QueryLogPanel />)
    fireEvent.click(screen.getByRole('button', { name: /query log/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('update t set x = 1'))

    fireEvent.click(screen.getByRole('button', { name: 'Open in new query tab' }))
    expect(openQueryTabWithSql).toHaveBeenCalledWith(
      'session-1',
      'update t set x = 1',
      'app_db',
    )
  })

  it('loads SQL into the active query tab', async () => {
    useQueryLogStore.setState({
      entries: [entry({ database: 'analytics', sql: 'select * from t' })],
    })
    const queryTab: Tab = {
      id: 'query-1',
      type: 'query',
      label: 'Query',
      sessionId: 'session-1',
    }
    const injectSqlToTab = vi.fn()
    const openQueryTabWithSql = vi.fn()
    useTabStore.setState({
      tabs: [queryTab],
      activeTabId: queryTab.id,
      injectSqlToTab,
      openQueryTabWithSql,
    })

    render(<QueryLogPanel />)
    fireEvent.click(screen.getByRole('button', { name: /query log/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }))

    expect(injectSqlToTab).toHaveBeenCalledWith(
      queryTab.id,
      'select * from t',
      'analytics',
    )
    expect(openQueryTabWithSql).not.toHaveBeenCalled()
  })

  it('disables replay when a persisted bulk entry has no full script', () => {
    useQueryLogStore.setState({
      entries: [
        entry({
          bulk: {
            statementCount: 2,
            operationCounts: { INSERT: 2 },
            rolledBack: false,
          },
        }),
      ],
    })

    render(<QueryLogPanel />)
    fireEvent.click(screen.getByRole('button', { name: /query log/i }))

    const copy = screen.getByRole('button', { name: 'Copy SQL' })
    const load = screen.getByRole('button', { name: 'Open in new query tab' })
    expect(copy).toBeDisabled()
    expect(load).toBeDisabled()
    expect(copy).toHaveAttribute('title', 'Full write script unavailable after reload')
  })

  it('clears the log from the expanded header', () => {
    useQueryLogStore.setState({ entries: [entry({})] })

    render(<QueryLogPanel />)
    fireEvent.click(screen.getByRole('button', { name: /query log/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear query log' }))

    expect(useQueryLogStore.getState().entries).toEqual([])
    expect(screen.getByText('No queries logged yet')).toBeInTheDocument()
  })
})
