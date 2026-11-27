import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdminConsole from '../../components/admin/AdminConsole'
import { api } from '../../api/client'
import type {
  AdminActivityEvent,
  AdminConnection,
  AdminOverview,
  AdminPresence,
  AdminQuery,
  AdminRetention,
  AdminUser,
} from '../../types'

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

const overview: AdminOverview = {
  connection_count: 1,
  managed_connection_count: 1,
  private_connection_count: 0,
  audit_event_count: 2,
  audit_user_count: 1,
  live_user_count: 1,
  active_query_count: 1,
  window_hours: 24,
  observed_at: 1,
}

const managedConnection: AdminConnection = {
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
  shared_user_count: 1,
}

const privateConnection: AdminConnection = {
  id: 'db-2',
  name: 'Private',
  host: 'localhost',
  port: 3307,
  username: 'alice',
  default_db: null,
  query_limit: 100,
  ssl_enabled: false,
  created_at: '2026-08-03T00:00:00Z',
  updated_at: '2026-08-04T00:00:00Z',
  selected_databases: [],
  managed: false,
  is_default: false,
  owner_username: 'alice',
  config_key: null,
  shared_user_count: 0,
}

const localConnection: AdminConnection = {
  ...privateConnection,
  id: 'db-3',
  name: 'Local',
  owner_username: null,
  selected_databases: ['one', 'two'],
}

const users: AdminUser[] = [
  { username: 'alice', active_clients: 1, active_tabs: 2, policy_state: 'allowed' },
  { username: 'bob', active_clients: 0, active_tabs: 0, policy_state: 'observed' },
]

const retention: AdminRetention = {
  older_than_days: 30,
  minimum_age_days: 7,
  eligible_count: 3,
  observed_at: 1,
}

function activityEvent(overrides: Partial<AdminActivityEvent> = {}): AdminActivityEvent {
  return {
    occurred_at: '2026-08-05T00:00:00Z',
    username: 'alice',
    method: 'GET',
    path: '/api/v1/sessions',
    session_id: 'session-1',
    details: null,
    status_code: 200,
    duration_ms: 4,
    ...overrides,
  }
}

function presence(overrides: Partial<AdminPresence> = {}): AdminPresence {
  return {
    username: 'alice',
    client_id: 'client-1',
    active_tab_id: 'tab-1',
    tabs: [{
      id: 'tab-1',
      type: 'query',
      label: 'Query — analytics',
      session_id: 'db-1',
      database: 'app',
      table: null,
    }],
    seen_at: '2026-08-05T00:00:00Z',
    age_seconds: 2,
    ...overrides,
  }
}

function query(overrides: Partial<AdminQuery> = {}): AdminQuery {
  return {
    session_id: 'db-1',
    execution_id: 'exec-1',
    username: 'alice',
    session_name: 'Reporting',
    database: 'app',
    tab_id: 'tab-1',
    sql: 'SELECT * FROM orders',
    started_at: '2026-08-05T00:00:00Z',
    elapsed_ms: 1200,
    state: 'running',
    kind: 'query',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function useDefaults() {
  vi.mocked(api.getAdminOverview).mockResolvedValue(overview)
  vi.mocked(api.getAdminConnections).mockResolvedValue({
    items: [managedConnection, privateConnection, localConnection],
    next_cursor: null,
    observed_at: 1,
  })
  vi.mocked(api.getAdminUsers).mockResolvedValue({ items: users, fingerprint: 'policy-1', observed_at: 1 })
  vi.mocked(api.getAdminActivity).mockResolvedValue({ items: [], observed_at: 1 })
  vi.mocked(api.getAdminQueries).mockResolvedValue({ items: [], observed_at: 1 })
  vi.mocked(api.getAdminPresence).mockResolvedValue({ items: [], stale_after_seconds: 45, observed_at: 1 })
  vi.mocked(api.getAdminRetention).mockResolvedValue(retention)
  vi.mocked(api.addAdminUser).mockResolvedValue({ ok: true, username: 'bob', fingerprint: 'policy-2' })
  vi.mocked(api.removeAdminUser).mockResolvedValue({
    ok: true,
    username: 'alice',
    fingerprint: 'policy-3',
    revoked_sessions: 1,
  })
  vi.mocked(api.purgeAdminRetention).mockResolvedValue({ deleted: 3, older_than_days: 30 })
}

async function openView(name: string, role: 'button' | 'tab' = 'button') {
  fireEvent.click(screen.getByRole(role, { name }))
}

describe('AdminConsole shell, storage, and errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores a valid view, renders metrics, and closes through the back button', async () => {
    localStorage.setItem('lagun-admin-view', 'activity')
    const onClose = vi.fn()
    render(<AdminConsole onClose={onClose} />)

    expect(await screen.findByRole('heading', { name: 'Query & API audit' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back to overview for an invalid or unreadable stored view', async () => {
    localStorage.setItem('lagun-admin-view', 'unknown')
    const view = render(<AdminConsole />)
    expect(await screen.findByRole('heading', { name: 'Workspace overview' })).toBeInTheDocument()
    view.unmount()

    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    render(<AdminConsole />)
    expect(await screen.findByRole('heading', { name: 'Workspace overview' })).toBeInTheDocument()
  })

  it('keeps navigation working when storing the view fails', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    await openView('Retention')
    expect(await screen.findByRole('heading', { name: 'Audit retention' })).toBeInTheDocument()
    await openView('Retention', 'tab')
    expect(screen.getByRole('heading', { name: 'Audit retention' })).toBeInTheDocument()
  })

  it('shows loading, then renders overview and every connection posture variant', async () => {
    const overviewGate = deferred<AdminOverview>()
    vi.mocked(api.getAdminOverview).mockReturnValueOnce(overviewGate.promise)
    render(<AdminConsole />)

    expect(screen.getByText('Loading')).toBeInTheDocument()
    overviewGate.resolve(overview)
    expect(await screen.findByRole('heading', { name: 'Workspace overview' })).toBeInTheDocument()
    expect(screen.getByText('Managed')).toBeInTheDocument()
    expect(screen.getByText('1 user')).toBeInTheDocument()
    expect(screen.getAllByText('Private').length).toBeGreaterThan(0)
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0)
    expect(screen.getByText('local user')).toBeInTheDocument()
    expect(screen.getByText('1 database')).toBeInTheDocument()
    expect(screen.getByText('All databases')).toBeInTheDocument()
    expect(screen.getByText('2 databases')).toBeInTheDocument()
  })

  it('shows the access error for Error and non-Error failures', async () => {
    vi.mocked(api.getAdminOverview).mockRejectedValueOnce(new Error('Forbidden'))
    const view = render(<AdminConsole />)
    expect(await screen.findByRole('heading', { name: 'Admin access required' })).toBeInTheDocument()
    expect(screen.getByText('Forbidden')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Authenticate' })).toHaveAttribute(
      'href',
      '/_auth/login?next=%2Fadmin',
    )
    view.unmount()

    vi.mocked(api.getAdminOverview).mockRejectedValueOnce('offline')
    render(<AdminConsole />)
    expect(await screen.findByText('Admin data unavailable.')).toBeInTheDocument()
  })

  it('shows an in-page alert on a refresh failure after data has loaded', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    vi.mocked(api.getAdminOverview).mockRejectedValueOnce(new Error('refresh failed'))

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('refresh failed')
  })
})

describe('AdminConsole users and retention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders allowed and observed users, validates the form, and clears its error', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Users (2)')

    expect(await screen.findByRole('heading', { name: 'Users & policy' })).toBeInTheDocument()
    expect(screen.getByText('1 allowed')).toBeInTheDocument()
    expect(screen.getByText('Allowed')).toBeInTheDocument()
    expect(screen.getByText('Observed only')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Allow user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an LDAP username.')
    const input = screen.getByLabelText('LDAP username')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'bob' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adds a user, guards duplicate submits, and reports a failed add', async () => {
    const gate = deferred<{ ok: boolean; username: string; fingerprint: string }>()
    vi.mocked(api.addAdminUser).mockImplementationOnce(() => gate.promise)
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Users (2)')
    await screen.findByRole('heading', { name: 'Users & policy' })

    const input = screen.getByLabelText('LDAP username')
    fireEvent.change(input, { target: { value: '  charlie  ' } })
    const form = screen.getByRole('form', { name: 'Add LDAP user' })
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(api.addAdminUser).toHaveBeenCalledOnce())
    expect(api.addAdminUser).toHaveBeenCalledWith('charlie', 'policy-1')
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled()
    await act(async () => gate.resolve({ ok: true, username: 'charlie', fingerprint: 'policy-2' }))
    expect(await screen.findByText('Added charlie to LDAP access policy.')).toBeInTheDocument()
    expect(input).toHaveValue('')

    vi.mocked(api.addAdminUser).mockRejectedValueOnce(new Error('add denied'))
    fireEvent.change(input, { target: { value: 'denied' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('add denied')
  })

  it('removes a user with cancelled and confirmed confirmations, including zero revoked sessions', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Users (2)')
    await screen.findByRole('heading', { name: 'Users & policy' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    vi.mocked(api.removeAdminUser).mockResolvedValueOnce({
      ok: true,
      username: 'alice',
      fingerprint: 'policy-4',
      revoked_sessions: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    await waitFor(() => expect(api.removeAdminUser).toHaveBeenCalledWith('alice', 'policy-1'))
    expect(await screen.findByText('Removed alice from LDAP access policy.')).toBeInTheDocument()

    vi.mocked(api.removeAdminUser).mockResolvedValueOnce({
      ok: true,
      username: 'alice',
      fingerprint: 'policy-single',
      revoked_sessions: 1,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    expect(await screen.findByText(/revoked 1 session\./)).toBeInTheDocument()

    vi.mocked(api.removeAdminUser).mockResolvedValueOnce({
      ok: true,
      username: 'alice',
      fingerprint: 'policy-5',
      revoked_sessions: 2,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    expect(await screen.findByText(/revoked 2 sessions/)).toBeInTheDocument()

    vi.mocked(api.removeAdminUser).mockResolvedValueOnce({
      ok: true,
      username: 'alice',
      fingerprint: 'policy-6',
      revoked_sessions: 3,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    expect(await screen.findByText(/revoked 3 sessions/)).toBeInTheDocument()
  })

  it('shows empty users and reports failed removals', async () => {
    vi.mocked(api.getAdminUsers).mockResolvedValue({ items: [], fingerprint: 'empty', observed_at: 1 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Users (0)')
    expect(await screen.findByText('No users in LDAP access policy.')).toBeInTheDocument()

    vi.mocked(api.getAdminUsers).mockResolvedValue({ items: users, fingerprint: 'policy-1', observed_at: 1 })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await screen.findByRole('button', { name: 'Remove' })
    vi.mocked(api.removeAdminUser).mockRejectedValueOnce('remove denied')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove user' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin data unavailable.')
  })

  it('purges one or many events and dismisses the notice', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Retention')
    vi.mocked(api.purgeAdminRetention).mockResolvedValueOnce({ deleted: 1, older_than_days: 30 })
    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))
    expect(await screen.findByText('Purged 1 audit event.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))
    expect(await screen.findByText('Purged 3 audit events.')).toBeInTheDocument()
  })

  it('dismisses notices after five seconds and reports purge failures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Retention')
    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))
    expect(await screen.findByText('Purged 3 audit events.')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.queryByText('Purged 3 audit events.')).not.toBeInTheDocument()

    vi.mocked(api.purgeAdminRetention).mockRejectedValueOnce(new Error('purge failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Purge history' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('purge failed')
  })

  it('closes purge confirmation, checks eligibility, and skips an unchanged day count', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Retention')
    const callsBefore = vi.mocked(api.getAdminRetention).mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Review purge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog', { name: 'Purge audit history?' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Check eligibility' }))
    await waitFor(() => expect(api.getAdminRetention).toHaveBeenCalledTimes(callsBefore + 1))

    const input = screen.getByLabelText('Delete events older than')
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(api.getAdminRetention).toHaveBeenCalledTimes(callsBefore + 1)
  })

  it('handles a missing retention summary and zero eligible events', async () => {
    const retentionGate = deferred<AdminRetention>()
    vi.mocked(api.getAdminRetention).mockReturnValueOnce(retentionGate.promise)
    render(<AdminConsole />)
    await openView('Retention')
    expect(await screen.findByRole('heading', { name: 'Audit retention' })).toBeInTheDocument()
    expect(screen.getByText('7 days')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review purge' })).toBeDisabled()
    retentionGate.resolve({ ...retention, eligible_count: 0 })
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Review purge' })).toBeDisabled()
  })

  it('clamps retention days across input, blur, and keyboard commits', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Retention')
    const input = await screen.findByLabelText('Delete events older than') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'abc' } })
    expect(input).toHaveValue(null)
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(7)
    await waitFor(() => expect(api.getAdminRetention).toHaveBeenCalledWith(7))

    fireEvent.change(input, { target: { value: '4000' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue(3650)
    await waitFor(() => expect(api.getAdminRetention).toHaveBeenCalledWith(3650))

    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(input).toHaveValue(30)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(7)
  })

})

describe('AdminConsole live workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows empty live state and opens the live view from the overview shortcut', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: 'Open live view' }))

    expect(await screen.findByRole('heading', { name: 'Live workspace' })).toBeInTheDocument()
    expect(screen.getByText('0 clients online')).toBeInTheDocument()
    expect(screen.getByText('No active users.')).toBeInTheDocument()
    expect(screen.getByText('Select a user to inspect their workspace.')).toBeInTheDocument()
    expect(screen.getByText('Select a user to inspect running queries.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sessions and tabs' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Active queries' })).toBeInTheDocument()
  })

  it('renders live tabs, query variants, user switching, and expanded sessions', async () => {
    const longSql = `SELECT * FROM orders WHERE customer = 'alice@example.test' ${'AND status = "open" '.repeat(20)}`
    const aliceTabs = [
      {
        id: 'tab-1',
        type: 'query' as const,
        label: 'Alice query',
        session_id: 'db-1',
        database: 'app',
        table: null,
      },
      {
        id: 'tab-2',
        type: 'table' as const,
        label: 'Default rows',
        session_id: 'db-1',
        database: null,
        table: 'orders',
        view: 'data' as const,
        global_search: 'alice',
        where_filter: null,
        row_limit: null,
      },
      {
        id: 'tab-3',
        type: 'table' as const,
        label: 'Schema only',
        session_id: 'db-1',
        database: null,
        table: null,
        view: 'schema' as const,
        global_search: null,
        where_filter: null,
      },
      {
        id: 'tab-4',
        type: 'table' as const,
        label: 'Filtered rows',
        session_id: 'db-1',
        database: 'analytics',
        table: 'events',
        view: 'data' as const,
        global_search: null,
        where_filter: "status = 'open'",
        row_limit: 250,
      },
      {
        id: 'tab-5',
        type: 'query' as const,
        label: 'Fifth tab',
        session_id: 'db-1',
        database: 'app',
        table: null,
      },
    ]
    vi.mocked(api.getAdminPresence).mockResolvedValueOnce({
      items: [
        presence({ tabs: aliceTabs }),
        presence({
          client_id: 'client-2',
          active_tab_id: 'tab-x',
          tabs: [{
            id: 'tab-x',
            type: 'table',
            label: 'Unknown session',
            session_id: 'missing-session',
            database: null,
            table: 'users',
            view: 'data',
            global_search: 'bob',
            where_filter: "active = 1",
            row_limit: 10,
          }],
        }),
        presence({
          username: 'bob',
          client_id: 'client-3',
          active_tab_id: null,
          tabs: [],
        }),
      ],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    vi.mocked(api.getAdminQueries).mockResolvedValueOnce({
      items: [
        query({ sql: longSql, elapsed_ms: 1_500 }),
        query({
          execution_id: 'exec-2',
          sql: '',
          session_name: '',
          database: null,
          tab_id: null,
          elapsed_ms: 5,
          state: 'queued',
          kind: 'bulk',
        }),
        query({
          execution_id: 'exec-3',
          username: 'carol',
          sql: 'SELECT 1',
          session_name: undefined,
          database: 'reporting',
          tab_id: null,
        }),
      ],
      observed_at: 1,
    })

    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Live workspace (1)')

    expect(await screen.findByRole('heading', { name: 'Live workspace' })).toBeInTheDocument()
    expect(screen.getByText('3 clients online')).toBeInTheDocument()
    const usersPanel = screen.getByRole('heading', { name: 'Users online' }).closest('section')!
    expect(within(usersPanel).getByRole('button', { name: /alice/ })).toHaveTextContent('2 sessions · 6 tabs')
    expect(within(usersPanel).getByRole('button', { name: /bob/ })).toHaveTextContent('0 sessions · 0 tabs')
    expect(within(usersPanel).getByRole('button', { name: /alice/ })).toHaveTextContent('2 running')

    expect(screen.getByRole('heading', { name: "alice's sessions and tabs" })).toBeInTheDocument()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('db.internal:3306 · readonly')).toBeInTheDocument()
    expect(screen.getAllByText('missing-session').length).toBeGreaterThan(0)
    expect(screen.getByText(/1,000 rows/)).toBeInTheDocument()
    expect(screen.getByText(/Schema view/)).toBeInTheDocument()
    expect(screen.getByText(/250 rows/)).toBeInTheDocument()
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0)
    expect(screen.getByText("status = 'open'")).toBeInTheDocument()
    expect(screen.getAllByText('Partial match').length).toBeGreaterThan(0)
    expect(screen.getAllByText('WHERE').length).toBeGreaterThan(0)
    expect(screen.getAllByText('active').length).toBeGreaterThan(0)

    const productionTabs = screen.getByRole('list', { name: 'Production tabs' })
    expect(within(productionTabs).getAllByRole('listitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 5 tabs' }))
    expect(within(productionTabs).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer tabs' }))
    expect(within(productionTabs).getAllByRole('listitem')).toHaveLength(4)

    expect(screen.getByText(/Show full SQL/)).toBeInTheDocument()
    expect(screen.getByText('Waiting for query text')).toBeInTheDocument()
    expect(screen.getByText('1.50 s')).toBeInTheDocument()
    expect(screen.getByText('5.0 ms')).toBeInTheDocument()
    expect(screen.getByText(/Reporting · app · tab tab-1/)).toBeInTheDocument()

    fireEvent.click(within(usersPanel).getByRole('button', { name: /bob/ }))
    expect(await screen.findByRole('heading', { name: "bob's sessions and tabs" })).toBeInTheDocument()
    expect(screen.getByText('No open tabs currently reported.')).toBeInTheDocument()
    expect(screen.getByText('No active queries for this user.')).toBeInTheDocument()

    fireEvent.click(within(usersPanel).getByRole('button', { name: /carol/ }))
    expect(await screen.findByRole('heading', { name: "carol's active queries" })).toBeInTheDocument()
    expect(screen.getByText('No open tabs currently reported.')).toBeInTheDocument()
    expect(screen.getByText(/reporting/)).toBeInTheDocument()
  })

  it('clears a selected user when a refresh removes it', async () => {
    vi.mocked(api.getAdminPresence).mockResolvedValueOnce({
      items: [presence()],
      stale_after_seconds: 45,
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Live workspace (1)')
    fireEvent.click(await screen.findByRole('button', { name: /alice/ }))
    expect(screen.getByRole('heading', { name: "alice's sessions and tabs" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByText('No active users.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sessions and tabs' })).toBeInTheDocument()
  })
})

describe('AdminConsole connections inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders private, managed, default, scoped, and active-tab connection details', async () => {
    const managedMany = {
      ...managedConnection,
      id: 'db-4',
      name: 'Managed Many',
      shared_user_count: 3,
      selected_databases: ['a', 'b'],
      is_default: false,
      ssl_enabled: false,
    }
    vi.mocked(api.getAdminConnections).mockResolvedValue({
      items: [managedConnection, privateConnection, localConnection, managedMany],
      next_cursor: null,
      observed_at: 1,
    })
    vi.mocked(api.getAdminPresence).mockResolvedValue({
      items: [
        presence({
          tabs: Array.from({ length: 5 }, (_, index) => ({
            id: `tab-${index}`,
            type: 'query' as const,
            label: `Alice tab ${index + 1}`,
            session_id: 'db-1',
            database: 'app',
            table: null,
          })),
        }),
        presence({ username: 'bob', client_id: 'client-bob', tabs: [{
          id: 'bob-tab',
          type: 'query',
          label: 'Bob tab',
          session_id: 'db-2',
          database: 'app',
          table: null,
        }] }),
      ],
      stale_after_seconds: 45,
      observed_at: 1,
    })

    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: 'View all' }))
    const table = await screen.findByRole('table', { name: 'Saved connection inventory and active users' })

    expect(within(table).getByText('default')).toBeInTheDocument()
    expect(within(table).getByText(/· TLS/)).toBeInTheDocument()
    expect(within(table).getAllByText('Managed profile')).toHaveLength(2)
    expect(within(table).getAllByText('Private profile')).toHaveLength(2)
    expect(within(table).getByText('1 allowed user')).toBeInTheDocument()
    expect(within(table).getByText('3 allowed users')).toBeInTheDocument()
    expect(within(table).getAllByText('alice').length).toBeGreaterThan(0)
    expect(within(table).getByText('local user')).toBeInTheDocument()
    expect(within(table).getAllByText('app').length).toBeGreaterThan(0)
    expect(within(table).getByText('a, b')).toBeInTheDocument()
    expect(within(table).getAllByText('All non-system schemas').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('No active users').length).toBeGreaterThan(0)

    const aliceTabs = screen.getByRole('list', { name: 'alice tabs' })
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 5 tabs' }))
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer tabs' }))
    expect(within(aliceTabs).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByRole('list', { name: 'bob tabs' })).toBeInTheDocument()
  })

  it('pages connections with deduplication and keeps older pages on refresh', async () => {
    const staging = { ...managedConnection, id: 'db-0', name: 'Staging', is_default: false }
    const connectedGate = deferred<{
      items: AdminConnection[]
      next_cursor: string | null
      observed_at: number
    }>()
    vi.mocked(api.getAdminConnections)
      .mockResolvedValueOnce({ items: [managedConnection], next_cursor: 'cursor-1', observed_at: 1 })
      .mockReturnValueOnce(connectedGate.promise)
      .mockResolvedValue({ items: [managedConnection], next_cursor: 'fresh-cursor', observed_at: 2 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Connections (1)')
    const table = await screen.findByRole('table', { name: 'Saved connection inventory and active users' })

    fireEvent.click(screen.getByRole('button', { name: 'Load more connections' }))
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    await act(async () => connectedGate.resolve({
      items: [managedConnection, staging],
      next_cursor: null,
      observed_at: 2,
    }))
    expect(within(table).getByText('Staging')).toBeInTheDocument()
    expect(within(table).getAllByText('Production')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load more connections' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(api.getAdminConnections).toHaveBeenCalledTimes(3))
    expect(within(table).getByText('Staging')).toBeInTheDocument()
    expect(within(table).getAllByText('Production')).toHaveLength(1)
  })

  it('reports a connection page failure and renders an empty inventory', async () => {
    vi.mocked(api.getAdminConnections)
      .mockResolvedValueOnce({ items: [managedConnection], next_cursor: 'cursor-1', observed_at: 1 })
      .mockRejectedValueOnce(new Error('page failed'))
    const view = render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Connections (1)')
    fireEvent.click(await screen.findByRole('button', { name: 'Load more connections' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('page failed')

    view.unmount()
    cleanup()
    localStorage.clear()
    useDefaults()
    vi.mocked(api.getAdminConnections).mockResolvedValue({ items: [], next_cursor: null, observed_at: 1 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Connections (1)')
    expect(await screen.findByText('No saved connections.')).toBeInTheDocument()
  })
})

describe('AdminConsole activity audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders empty audit state and a detailed failed event', async () => {
    vi.mocked(api.getAdminActivity).mockResolvedValueOnce({
      items: [activityEvent({
        method: 'POST',
        path: '/api/v1/query',
        details: '{"sql":"SELECT 1"}',
        status_code: 500,
        duration_ms: 42,
      })],
      observed_at: 1,
    })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')

    expect(await screen.findByText('POST /api/v1/query')).toBeInTheDocument()
    expect(screen.getByText('500')).toHaveClass('bg-red-950/50')
    fireEvent.click(screen.getByText(/Show raw request body/))
    expect(screen.getByLabelText('Raw request body for POST /api/v1/query')).toHaveTextContent(
      '{"sql":"SELECT 1"}',
    )

    vi.mocked(api.getAdminActivity).mockResolvedValueOnce({ items: [], observed_at: 1 })
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'nobody' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    expect(await screen.findByText('No matching audit events.')).toBeInTheDocument()
  })

  it('applies every filter by Enter, ignores unrelated keys, and clears filters', async () => {
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    const userInput = await screen.findByLabelText('User contains')
    fireEvent.change(userInput, { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('Path contains'), { target: { value: '/query' } })
    fireEvent.change(screen.getByLabelText('Partial match'), { target: { value: 'SELECT' } })
    fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '500' } })
    fireEvent.keyDown(userInput, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Search' }), { key: 'Enter' })
    expect(api.getAdminActivity).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(userInput, { key: 'Enter' })
    await waitFor(() => expect(api.getAdminActivity).toHaveBeenCalledWith({
      username: 'alice',
      path: '/query',
      search: 'SELECT',
      since: '2026-08-01',
      statusCode: 500,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(api.getAdminActivity).toHaveBeenCalledWith({}))
    expect(userInput).toHaveValue('')
  })

  it('loads older events, exposes loading, and ignores pages made stale by filters', async () => {
    const olderGate = deferred<{ items: AdminActivityEvent[]; next_before_id?: number | null; observed_at: number }>()
    vi.mocked(api.getAdminActivity)
      .mockResolvedValueOnce({
        items: [activityEvent({ path: '/newest' })],
        next_before_id: 42,
        observed_at: 1,
      })
      .mockReturnValueOnce(olderGate.promise)
      .mockResolvedValue({ items: [activityEvent({ path: '/filtered' })], observed_at: 2 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    expect(await screen.findByText('GET /newest')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load 100 older' }))
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'alice' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('GET /filtered')).toBeInTheDocument())
    await act(async () => olderGate.resolve({
      items: [activityEvent({ path: '/stale-page' })],
      next_before_id: 10,
      observed_at: 2,
    }))
    expect(screen.queryByText('GET /stale-page')).not.toBeInTheDocument()
  })

  it('ignores an older-page failure made stale by a filter change', async () => {
    const olderGate = deferred<{
      items: AdminActivityEvent[]
      next_before_id?: number | null
      observed_at: number
    }>()
    vi.mocked(api.getAdminActivity)
      .mockResolvedValueOnce({
        items: [activityEvent({ path: '/newest' })],
        next_before_id: 42,
        observed_at: 1,
      })
      .mockReturnValueOnce(olderGate.promise)
      .mockResolvedValue({ items: [activityEvent({ path: '/filtered' })], observed_at: 2 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    fireEvent.click(await screen.findByRole('button', { name: 'Load 100 older' }))
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'alice' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    await screen.findByText('GET /filtered')
    await act(async () => olderGate.reject(new Error('stale older failure')))
    expect(screen.queryByText('stale older failure')).not.toBeInTheDocument()
  })

  it('appends the next page and hides the pager at the final page', async () => {
    vi.mocked(api.getAdminActivity)
      .mockResolvedValueOnce({
        items: [activityEvent({ path: '/newest' })],
        next_before_id: 42,
        observed_at: 1,
      })
      .mockResolvedValueOnce({
        items: [activityEvent({ path: '/older' })],
        next_before_id: null,
        observed_at: 2,
      })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    fireEvent.click(await screen.findByRole('button', { name: 'Load 100 older' }))
    expect(await screen.findByText('GET /older')).toBeInTheDocument()
    expect(screen.getByText('GET /newest')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load 100 older' })).not.toBeInTheDocument()

  })

  it('reports a paging failure', async () => {
    vi.mocked(api.getAdminActivity)
      .mockResolvedValueOnce({
        items: [activityEvent({ path: '/again' })],
        next_before_id: 99,
        observed_at: 2,
      })
      .mockRejectedValueOnce(new Error('older failed'))
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    fireEvent.click(await screen.findByRole('button', { name: 'Load 100 older' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('older failed')
  })

  it('preserves duplicate audit rows and the cursor across same-filter refreshes', async () => {
    const event = activityEvent({ path: '/same' })
    vi.mocked(api.getAdminActivity)
      .mockResolvedValueOnce({ items: [event], next_before_id: 7, observed_at: 1 })
      .mockResolvedValueOnce({ items: [event], next_before_id: 9, observed_at: 2 })
      .mockResolvedValueOnce({ items: [event], next_before_id: 99, observed_at: 3 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    await openView('Query & API audit')
    fireEvent.change(await screen.findByLabelText('User contains'), { target: { value: 'alice' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('GET /same')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(screen.getAllByText('GET /same')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Load 100 older' }))
    await waitFor(() => expect(api.getAdminActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ username: 'alice' }),
      9,
    ))
  })
})

describe('AdminConsole refresh generations and timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDefaults()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ignores a stale successful refresh that resolves after a newer refresh', async () => {
    const stale = deferred<AdminOverview>()
    vi.mocked(api.getAdminOverview)
      .mockResolvedValueOnce(overview)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ...overview, connection_count: 2 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await openView('Query & API audit')
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'alice' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    await waitFor(() => expect(api.getAdminOverview).toHaveBeenCalledTimes(3))
    await act(async () => stale.resolve({ ...overview, connection_count: 99 }))

    expect(screen.getByRole('button', { name: 'Connections (2)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connections (99)' })).not.toBeInTheDocument()
  })

  it('ignores a stale failed refresh', async () => {
    const stale = deferred<AdminOverview>()
    vi.mocked(api.getAdminOverview)
      .mockResolvedValueOnce(overview)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ...overview, connection_count: 2 })
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await openView('Query & API audit')
    fireEvent.change(screen.getByLabelText('User contains'), { target: { value: 'alice' } })
    fireEvent.keyDown(screen.getByLabelText('User contains'), { key: 'Enter' })
    await waitFor(() => expect(api.getAdminOverview).toHaveBeenCalledTimes(3))
    await act(async () => stale.reject(new Error('stale failure')))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('updates the relative age through minutes, hours, and days', async () => {
    const now = new Date('2026-08-05T00:00:00Z')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(now)
    render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    expect(screen.getByText('Updated 0s ago')).toBeInTheDocument()

    vi.setSystemTime(new Date(now.getTime() + 61_000))
    await openView('Connections (1)')
    expect(screen.getByText('Updated 1m ago')).toBeInTheDocument()

    vi.setSystemTime(new Date(now.getTime() + 3_601_000))
    await openView('Users (2)')
    expect(screen.getByText('Updated 1h ago')).toBeInTheDocument()

    vi.setSystemTime(new Date(now.getTime() + 86_401_000))
    await openView('Retention')
    expect(screen.getByText('Updated 1d ago')).toBeInTheDocument()
  })

  it('refreshes on the fifteen-second heartbeat and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const view = render(<AdminConsole />)
    await screen.findByRole('heading', { name: 'Workspace overview' })
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    await waitFor(() => expect(api.getAdminOverview).toHaveBeenCalledTimes(2))
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(api.getAdminOverview).toHaveBeenCalledTimes(2)
  })
})
