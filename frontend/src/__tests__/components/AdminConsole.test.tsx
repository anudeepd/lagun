import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import AdminConsole from '../../components/admin/AdminConsole'

vi.mock('../../api/client', () => ({
  api: {
    getAdminOverview: vi.fn(),
    getAdminConnections: vi.fn(),
    getAdminUsers: vi.fn(),
    getAdminActivity: vi.fn(),
    getAdminRetention: vi.fn(),
    getAdminQueries: vi.fn(),
    getAdminPresence: vi.fn(),
    addAdminUser: vi.fn(),
    removeAdminUser: vi.fn(),
    purgeAdminRetention: vi.fn(),
  },
}))

const overview = {
  connection_count: 1,
  managed_connection_count: 1,
  private_connection_count: 0,
  audit_event_count: 2,
  audit_user_count: 1,
  live_user_count: 1,
  active_query_count: 0,
  window_hours: 24,
  observed_at: 1,
}

const connection = {
  id: 'db-1',
  name: 'Production',
  host: 'db.internal',
  port: 3306,
  username: 'readonly',
  default_db: 'app',
  query_limit: 100,
  ssl_enabled: true,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  selected_databases: ['app'],
  managed: true,
  is_default: true,
  owner_username: null,
  config_key: 'production',
  shared_user_count: 2,
}
const users = {
  items: [
    { username: 'alice', active_clients: 1, active_tabs: 2, policy_state: 'allowed' as const },
  ],
  fingerprint: 'policy-1',
  observed_at: 1,
}


const retention = {
  older_than_days: 30,
  minimum_age_days: 7,
  eligible_count: 3,
  observed_at: 1,
}

beforeEach(() => {
  vi.mocked(api.getAdminOverview).mockResolvedValue(overview)
  vi.mocked(api.getAdminConnections).mockResolvedValue({ items: [connection], observed_at: 1 })
  vi.mocked(api.getAdminUsers).mockResolvedValue(users)
  vi.mocked(api.getAdminActivity).mockResolvedValue({ items: [], observed_at: 1 })
  vi.mocked(api.getAdminQueries).mockResolvedValue({ items: [], observed_at: 1 })
  vi.mocked(api.getAdminPresence).mockResolvedValue({ items: [], stale_after_seconds: 45, observed_at: 1 })
  vi.mocked(api.getAdminRetention).mockResolvedValue(retention)
  vi.mocked(api.addAdminUser).mockResolvedValue({ ok: true, username: 'bob', fingerprint: 'policy-2' })
  vi.mocked(api.removeAdminUser).mockResolvedValue({ ok: true, username: 'alice', fingerprint: 'policy-3', revoked_sessions: 1 })
  vi.mocked(api.purgeAdminRetention).mockResolvedValue({ deleted: 3, older_than_days: 30 })
})

afterEach(() => {
  localStorage.removeItem('lagun-admin-view')
  vi.clearAllMocks()
})

describe('AdminConsole', () => {
  it('renders overview metrics and managed connection posture', async () => {
    render(<AdminConsole />)

    expect(await screen.findByRole('heading', { name: 'Workspace overview' })).toBeInTheDocument()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('Managed')).toBeInTheDocument()
    expect(screen.getByText('2 users')).toBeInTheDocument()
    expect(screen.getByText('Connection profiles')).toBeInTheDocument()
  })
  it('keeps admin data in vertical scroll regions without horizontal overflow', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    const expectVerticalTable = (name: string) => {
      const table = screen.getByRole('table', { name })
      expect(table).toHaveClass('table-fixed')
      expect(table.parentElement).toHaveClass('overflow-y-auto', 'overflow-x-hidden')
    }

    expectVerticalTable('Connection posture preview')
    fireEvent.click(screen.getByRole('button', { name: 'Users (1)' }))
    expectVerticalTable('LDAP access policy and live workspace activity')
    fireEvent.click(screen.getByRole('button', { name: 'Connections (1)' }))
    expectVerticalTable('Saved connection inventory and active users')
    fireEvent.click(screen.getByRole('button', { name: 'Query & API audit' }))
    expectVerticalTable('Lagun API audit events with raw request targets and bodies')
  })
  it('restores selected admin view after remount', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: 'Retention' }))
    expect(await screen.findByRole('heading', { name: 'Audit retention' })).toBeInTheDocument()
    expect(localStorage.getItem('lagun-admin-view')).toBe('retention')

    cleanup()
    render(<AdminConsole />)
    expect(await screen.findByRole('heading', { name: 'Audit retention' })).toBeInTheDocument()
  })

  it('applies partial activity filters when Enter is pressed', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: 'Query & API audit' }))
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'ali' } })
    fireEvent.change(screen.getByLabelText('Path contains'), { target: { value: '/query' } })
    const partialMatch = screen.getByLabelText('Partial match')
    fireEvent.change(partialMatch, { target: { value: 'customer_email' } })
    fireEvent.keyDown(partialMatch, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(api.getAdminActivity).toHaveBeenCalledWith({
      username: 'ali',
      path: '/query',
      search: 'customer_email',
      since: '',
      statusCode: undefined,
    }))
  })
  it('shows raw query targets and complete request bodies', async () => {
    const payload = '{"sql":"SELECT * FROM users WHERE email=\'alice@example.test\'","filters":{"active":true}}'
    vi.mocked(api.getAdminActivity).mockResolvedValueOnce({
      items: [{
        occurred_at: '2026-08-05T00:00:00Z',
        username: 'alice',
        method: 'POST',
        path: '/api/v1/sessions/session-1/query?view=raw%20rows',
        session_id: 'session-1',
        details: payload,
        status_code: 200,
        duration_ms: 4,
      }],
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: 'Query & API audit' }))
    expect(await screen.findByText('POST /api/v1/sessions/session-1/query?view=raw%20rows')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Show raw request body/))

    expect(screen.getByLabelText('Raw request body for POST /api/v1/sessions/session-1/query?view=raw%20rows')).toHaveTextContent(payload)
  })


  it('shows live users, open tabs, and active query metadata', async () => {
    vi.mocked(api.getAdminPresence).mockResolvedValueOnce({
      items: [{
        username: 'alice',
        client_id: 'client-1',
        active_tab_id: 'tab-1',
        tabs: [{
          id: 'tab-1',
          type: 'query',
          label: 'Query — analytics',
          session_id: 'session-1',
          database: 'analytics',
          table: null,
        }, {
          id: 'tab-2',
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
        seen_at: '2026-08-05T00:00:00Z',
        age_seconds: 2,
      }],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    vi.mocked(api.getAdminQueries).mockResolvedValueOnce({
      items: [{
        session_id: 'session-1',
        execution_id: 'exec-1',
        username: 'alice',
        session_name: 'Reporting',
        database: 'analytics',
        tab_id: 'tab-1',
        sql: "SELECT * FROM orders WHERE customer='alice@example.test'",
        started_at: '2026-08-05T00:00:00Z',
        elapsed_ms: 1200,
        state: 'running',
        kind: 'query',
      }],
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: /Live workspace/ }))

    expect(await screen.findByRole('heading', { name: 'Live workspace' })).toBeInTheDocument()
    expect(screen.getByText('Query — analytics')).toBeInTheDocument()
    expect(screen.getByText(/SELECT \* FROM orders/)).toBeInTheDocument()
    expect(screen.getByText(/Data view · up to 250 rows/)).toBeInTheDocument()
    expect(screen.getByText('alice@example.test')).toBeInTheDocument()
    expect(screen.getByText("status = 'open' AND total >= 250")).toBeInTheDocument()
  })
  it('previews oversized live sessions and SQL by default', async () => {
    const longSql = `SELECT * FROM orders WHERE customer = 'alice@example.test' ${'AND status = "open" '.repeat(20)}`
    vi.mocked(api.getAdminPresence).mockResolvedValueOnce({
      items: [{
        username: 'alice',
        client_id: 'client-1',
        active_tab_id: 'tab-1',
        tabs: Array.from({ length: 5 }, (_, index) => ({
          id: `tab-${index + 1}`,
          type: 'query',
          label: `Query ${index + 1}`,
          session_id: 'session-1',
          database: 'analytics',
          table: null,
        })),
        seen_at: '2026-08-05T00:00:00Z',
        age_seconds: 2,
      }],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    vi.mocked(api.getAdminQueries).mockResolvedValueOnce({
      items: [{
        session_id: 'session-1',
        execution_id: 'exec-1',
        username: 'alice',
        session_name: 'Reporting',
        database: 'analytics',
        tab_id: 'tab-1',
        sql: longSql,
        started_at: '2026-08-05T00:00:00Z',
        elapsed_ms: 1200,
        state: 'running',
        kind: 'query',
      }],
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: /Live workspace/ }))

    const liveTabs = screen.getByRole('list', { name: 'session-1 tabs' })
    expect(within(liveTabs).getAllByRole('listitem')).toHaveLength(4)
    expect(within(liveTabs).queryByText('Query 5')).not.toBeInTheDocument()
    const showAllTabs = screen.getByRole('button', { name: 'Show all 5 tabs' })
    expect(showAllTabs).toHaveAttribute('aria-expanded', 'false')
    const sqlDetails = screen.getByText(/Show full SQL/).closest('details')
    expect(sqlDetails?.open).toBe(false)

    fireEvent.click(showAllTabs)
    fireEvent.click(screen.getByText(/Show full SQL/))
    expect(within(liveTabs).getAllByRole('listitem')).toHaveLength(5)
    expect(within(liveTabs).getByText('Query 5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show fewer tabs' })).toHaveAttribute('aria-expanded', 'true')
    expect(sqlDetails?.open).toBe(true)
  })
  it('filters sessions, tabs, and queries when selecting a user', async () => {
    vi.mocked(api.getAdminPresence).mockResolvedValueOnce({
      items: [
        {
          username: 'alice',
          client_id: 'client-alice',
          active_tab_id: 'tab-alice',
          tabs: [{
            id: 'tab-alice',
            type: 'query',
            label: 'Alice orders',
            session_id: 'db-1',
            database: 'app',
            table: null,
          }],
          seen_at: '2026-08-05T00:00:00Z',
          age_seconds: 2,
        },
        {
          username: 'bob',
          client_id: 'client-bob',
          active_tab_id: 'tab-bob',
          tabs: [{
            id: 'tab-bob',
            type: 'table',
            label: 'Bob customers',
            session_id: 'db-1',
            database: 'app',
            table: 'customers',
          }],
          seen_at: '2026-08-05T00:00:00Z',
          age_seconds: 3,
        },
      ],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    vi.mocked(api.getAdminQueries).mockResolvedValueOnce({
      items: [
        {
          session_id: 'db-1',
          execution_id: 'exec-alice',
          username: 'alice',
          session_name: 'Production',
          database: 'app',
          tab_id: 'tab-alice',
          sql: 'SELECT * FROM orders',
          started_at: '2026-08-05T00:00:00Z',
          elapsed_ms: 1200,
          state: 'running',
          kind: 'query',
        },
        {
          session_id: 'db-1',
          execution_id: 'exec-bob',
          username: 'bob',
          session_name: 'Production',
          database: 'app',
          tab_id: 'tab-bob',
          sql: 'SELECT * FROM customers',
          started_at: '2026-08-05T00:00:00Z',
          elapsed_ms: 800,
          state: 'running',
          kind: 'query',
        },
      ],
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: /Live workspace/ }))

    expect(await screen.findByRole('heading', { name: "alice's sessions and tabs" })).toBeInTheDocument()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('SELECT * FROM orders')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /bob/i }))

    expect(await screen.findByRole('heading', { name: "bob's sessions and tabs" })).toBeInTheDocument()
    expect(screen.getByText('Bob customers')).toBeInTheDocument()
    expect(screen.getByText('SELECT * FROM customers')).toBeInTheDocument()
    expect(screen.queryByText('SELECT * FROM orders')).not.toBeInTheDocument()
  })
  it('shows active users and tabs beside their connection metadata', async () => {
    vi.mocked(api.getAdminPresence).mockResolvedValue({
      items: [{
        username: 'alice',
        client_id: 'client-alice',
        active_tab_id: 'tab-reporting',
        tabs: [{
          id: 'tab-reporting',
          type: 'query',
          label: 'Reporting query',
          session_id: 'db-1',
          database: 'app',
          table: null,
        }, {
          id: 'tab-schema',
          type: 'table',
          label: 'Schema browser',
          session_id: 'db-1',
          database: 'app',
          table: 'users',
          view: 'schema',
        }, {
          id: 'tab-audit',
          type: 'query',
          label: 'Audit query',
          session_id: 'db-1',
          database: 'app',
          table: null,
        }, {
          id: 'tab-data',
          type: 'table',
          label: 'Data browser',
          session_id: 'db-1',
          database: 'app',
          table: 'orders',
          view: 'data',
        }, {
          id: 'tab-jobs',
          type: 'query',
          label: 'Recent jobs',
          session_id: 'db-1',
          database: 'app',
          table: null,
        }],
        seen_at: '2026-08-05T00:00:00Z',
        age_seconds: 2,
      }],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: 'Connections (1)' }))

    expect(await screen.findByRole('heading', { name: 'Connection inventory' })).toBeInTheDocument()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    const aliceTabs = screen.getByRole('list', { name: 'alice tabs' })
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(4)
    expect(within(aliceTabs).getByText('Reporting query')).toBeInTheDocument()
    expect(within(aliceTabs).getByText('Schema browser')).toBeInTheDocument()
    expect(within(aliceTabs).queryByText('Recent jobs')).not.toBeInTheDocument()
    const showAllTabs = screen.getByRole('button', { name: 'Show all 5 tabs' })
    expect(showAllTabs).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(showAllTabs)
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(5)
    expect(within(aliceTabs).getByText('Recent jobs')).toBeInTheDocument()
    const showFewerTabs = screen.getByRole('button', { name: 'Show fewer tabs' })
    expect(showFewerTabs).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(showFewerTabs)
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(4)
  })


  it('requires confirmation before purging eligible audit events', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: 'Retention' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    expect(screen.getByRole('dialog', { name: 'Purge audit history?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))

    await waitFor(() => expect(api.purgeAdminRetention).toHaveBeenCalledWith(30))
    expect(await screen.findByRole('status')).toHaveTextContent('Purged 3 audit events.')
  })
  it('allows replacing retention days with a multi-digit value', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: 'Retention' }))
    const input = await screen.findByLabelText('Delete events older than') as HTMLInputElement
    const user = userEvent.setup()

    await user.clear(input)
    await user.type(input, '7')
    await user.clear(input)
    await user.type(input, '30')

    expect(input).toHaveValue(30)
    fireEvent.blur(input)
    expect(input).toHaveValue(30)
  })
  it('dismisses success notices after five seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<AdminConsole />)
      await screen.findByRole('heading', { name: 'Workspace overview' })

      fireEvent.click(screen.getByRole('button', { name: 'Retention' }))
      fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
      fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Purged 3 audit events.'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
  it('adds and removes LDAP users with confirmation', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: 'Users (1)' }))
    expect(await screen.findByRole('heading', { name: 'Users & policy' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('LDAP username'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow user' }))
    await waitFor(() => expect(api.addAdminUser).toHaveBeenCalledWith('bob', 'policy-1'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('dialog', { name: 'Remove LDAP user?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    await waitFor(() => expect(api.removeAdminUser).toHaveBeenCalledWith('alice', 'policy-1'))
  })

})
