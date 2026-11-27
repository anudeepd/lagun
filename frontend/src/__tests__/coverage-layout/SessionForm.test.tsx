import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionForm from '../../components/sessions/SessionForm'
import { useSessionStore } from '../../store/sessionStore'
import { useServerConfigStore } from '../../store/serverConfigStore'
import { api } from '../../api/client'
import { mockSession } from '../handlers'
import type { Session, TestResult } from '../../types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const managed = (patch: Partial<Session> = {}): Session => ({
  ...mockSession,
  managed: true,
  ...patch,
})

describe('SessionForm coverage', () => {
  const createSession = vi.fn()
  const updateSession = vi.fn()
  const testSession = vi.fn()

  beforeEach(() => {
    createSession.mockReset().mockResolvedValue(mockSession)
    updateSession.mockReset().mockResolvedValue(mockSession)
    testSession.mockReset().mockResolvedValue({
      ok: true,
      server_version: '8.4.0',
      latency_ms: 3.5,
      databases: ['app_db'],
    })
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      loading: false,
      error: null,
      createSession,
      updateSession,
      testSession,
    })
    useServerConfigStore.setState({ queryMaxResultRows: 100 })
    vi.spyOn(api, 'probeConnection').mockResolvedValue({
      ok: true,
      server_version: '8.4.0',
      latency_ms: 2.5,
      databases: ['app_db', 'analytics'],
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('resets to new-connection defaults when reopened', async () => {
    const view = render(<SessionForm open={false} onClose={() => {}} />)
    expect(screen.queryByText('New Connection')).not.toBeInTheDocument()

    view.rerender(<SessionForm open onClose={() => {}} />)
    expect(screen.getByText('New Connection')).toBeInTheDocument()
    expect(screen.getByLabelText('Connection Name')).toHaveValue('')
    expect(screen.getByLabelText('Host')).toHaveValue('localhost')
    expect(screen.getByLabelText('Port')).toHaveValue(3306)
    expect(screen.getByLabelText('Username')).toHaveValue('root')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Default Database (optional)')).toHaveValue('')
    expect(screen.getByLabelText('Row Limit')).toHaveValue(100)
    expect(screen.getByLabelText('Enable SSL')).not.toBeChecked()
  })

  it('prefills editable and managed sessions without exposing the stored password', () => {
    const personal: Session = {
      ...mockSession,
      default_db: null,
      selected_databases: undefined as unknown as string[],
    }
    const view = render(<SessionForm open onClose={() => {}} session={personal} />)

    expect(screen.getByText('Edit Connection')).toBeInTheDocument()
    expect(screen.getByLabelText('Connection Name')).toHaveValue(mockSession.name)
    expect(screen.getByLabelText('Host')).toHaveValue(mockSession.host)
    expect(screen.getByLabelText('Port')).toHaveValue(mockSession.port)
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', '(unchanged)')
    expect(screen.getByLabelText('Default Database (optional)')).toHaveValue('')
    expect(screen.getByLabelText('Connection Name')).toBeEnabled()

    view.rerender(
      <SessionForm open onClose={() => {}} session={managed({ managed_selected_databases: undefined })} />,
    )
    expect(screen.getByLabelText('Connection Name')).toBeDisabled()
    expect(screen.getByLabelText('Host')).toBeDisabled()
    expect(screen.getByLabelText('Enable SSL')).toBeDisabled()
    expect(screen.getByText('Databases')).toBeInTheDocument()

    view.rerender(
      <SessionForm
        open
        onClose={() => {}}
        session={managed({ managed_selected_databases: ['app_db'] })}
      />,
    )
    expect(
      screen.getByText("Databases (within the administrator's allowed list)"),
    ).toBeInTheDocument()
  })

  it('validates required identity fields and focuses the first invalid one', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Connection name is required.')
    expect(screen.getByLabelText('Connection Name')).toHaveFocus()

    await user.type(screen.getByLabelText('Connection Name'), '  ')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Connection name is required.')

    await user.clear(screen.getByLabelText('Connection Name'))
    await user.type(screen.getByLabelText('Connection Name'), 'New DB')
    await user.clear(screen.getByLabelText('Username'))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Username is required.')
    expect(screen.getByLabelText('Username')).toHaveFocus()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('validates each port and query-limit boundary', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)
    await user.type(screen.getByLabelText('Connection Name'), 'Boundary DB')

    const port = screen.getByLabelText('Port')
    for (const value of ['abc', '0', '70000']) {
      fireEvent.change(port, { target: { value } })
      await user.click(screen.getByRole('button', { name: 'Create' }))
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Port must be a number between 1 and 65535.',
      )
      expect(port).toHaveFocus()
    }

    fireEvent.change(port, { target: { value: '3306' } })
    const limit = screen.getByLabelText('Row Limit')
    for (const value of ['abc', '0', '101']) {
      fireEvent.change(limit, { target: { value } })
      await user.click(screen.getByRole('button', { name: 'Create' }))
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Query limit must be a number between 1 and 100.',
      )
      expect(limit).toHaveFocus()
    }
    expect(createSession).not.toHaveBeenCalled()
  })

  it('creates a connection with normalized values and every optional field', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SessionForm open onClose={onClose} />)

    await user.type(screen.getByLabelText('Connection Name'), ' Production ')
    await user.clear(screen.getByLabelText('Host'))
    await user.type(screen.getByLabelText('Username'), '-admin')
    await user.type(screen.getByLabelText('Password'), 'p@ss')
    await user.type(screen.getByLabelText('Default Database (optional)'), 'main')
    await user.clear(screen.getByLabelText('Row Limit'))
    await user.type(screen.getByLabelText('Row Limit'), '25')
    await user.click(screen.getByLabelText('Enable SSL'))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(createSession).toHaveBeenCalledWith({
      name: 'Production',
      host: 'localhost',
      port: 3306,
      username: 'root-admin',
      password: 'p@ss',
      default_db: 'main',
      query_limit: 25,
      ssl_enabled: true,
      selected_databases: [],
    })
  })

  it('updates an unmanaged connection without sending an empty password', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SessionForm open onClose={onClose} session={mockSession} />)

    await user.clear(screen.getByLabelText('Connection Name'))
    await user.type(screen.getByLabelText('Connection Name'), 'Renamed')
    await user.clear(screen.getByLabelText('Default Database (optional)'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(updateSession).toHaveBeenCalledWith(mockSession.id, expect.objectContaining({
      name: 'Renamed',
      host: 'localhost',
      username: 'root',
      query_limit: 100,
      ssl_enabled: false,
      selected_databases: [],
    }))
    expect(updateSession.mock.calls[0][1]).not.toHaveProperty('password')
  })

  it('sends only the database selection when updating a managed connection', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <SessionForm
        open
        onClose={onClose}
        session={managed({ selected_databases: ['app_db'] })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(updateSession).toHaveBeenCalledWith(mockSession.id, {
      selected_databases: ['app_db'],
    })
  })

  it('falls back to one million rows when the server limit is falsey', async () => {
    useServerConfigStore.setState({ queryMaxResultRows: 0 })
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)

    expect(screen.getByLabelText('Row Limit')).toHaveAttribute('max', '1000000')
    await user.type(screen.getByLabelText('Connection Name'), 'Fallback')
    fireEvent.change(screen.getByLabelText('Row Limit'), { target: { value: '1000000' } })
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce())
  })

  it('shows save failures from Error and non-Error rejections', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)
    await user.type(screen.getByLabelText('Connection Name'), 'Broken')

    createSession.mockRejectedValueOnce(new Error('Duplicate name'))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate name')

    createSession.mockRejectedValueOnce('server unavailable')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('server unavailable')
  })

  it('keeps saving busy until the request settles', async () => {
    const request = deferred<Session>()
    createSession.mockReturnValueOnce(request.promise)
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)
    await user.type(screen.getByLabelText('Connection Name'), 'Slow')

    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    request.resolve(mockSession)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())
  })

  it('ignores a save that finishes after the dialog closes and reopens', async () => {
    const request = deferred<Session>()
    createSession.mockReturnValueOnce(request.promise)
    const onClose = vi.fn()
    const view = render(<SessionForm open onClose={onClose} />)
    await userEvent.type(screen.getByLabelText('Connection Name'), 'Abandoned')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    view.rerender(<SessionForm open={false} onClose={onClose} />)
    view.rerender(<SessionForm open onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled())

    await act(async () => {
      request.resolve(mockSession)
      await request.promise
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })

  it('ignores a save rejection that belongs to a previous open', async () => {
    const request = deferred<Session>()
    createSession.mockReturnValueOnce(request.promise)
    const view = render(<SessionForm open onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText('Connection Name'), 'Abandoned')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    view.rerender(<SessionForm open={false} onClose={() => {}} />)
    view.rerender(<SessionForm open onClose={() => {}} />)
    await act(async () => {
      request.reject(new Error('late failure'))
      await request.promise.catch(() => {})
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('probes a new connection and reports success', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)

    await user.type(screen.getByLabelText('Connection Name'), 'Probe')
    await user.click(screen.getByRole('button', { name: 'Test' }))

    expect(await screen.findByText('Connected! MySQL 8.4.0 — 2.5ms')).toBeInTheDocument()
    expect(api.probeConnection).toHaveBeenCalledWith({
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: '',
      ssl_enabled: false,
    })
  })

  it('rejects an invalid probe port without calling the API', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '99999' } })

    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Port must be a number between 1 and 65535.',
    )
    expect(screen.getByLabelText('Port')).toHaveFocus()
    expect(api.probeConnection).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled()
  })

  it('renders explicit and fallback connection failures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.probeConnection).mockResolvedValueOnce({
      ok: false,
      error: 'Access denied',
      latency_ms: 1,
      databases: [],
    })
    render(<SessionForm open onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Access denied')).toBeInTheDocument()

    vi.mocked(api.probeConnection).mockResolvedValueOnce({
      ok: false,
      error: null as unknown as string,
      latency_ms: 1,
      databases: [],
    })
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Connection failed')).toBeInTheDocument()
  })

  it('tests an existing connection through the session endpoint', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} session={mockSession} />)

    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Connected! MySQL 8.4.0 — 3.5ms')).toBeInTheDocument()
    expect(testSession).toHaveBeenCalledWith(mockSession.id)
    expect(api.probeConnection).not.toHaveBeenCalled()
  })

  it('shows connection-test exceptions and string failures', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} session={mockSession} />)

    testSession.mockRejectedValueOnce(new Error('socket closed'))
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('socket closed')).toBeInTheDocument()

    testSession.mockRejectedValueOnce('timeout')
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('timeout')).toBeInTheDocument()
  })

  it('ignores a test result that arrives after a close and reopen', async () => {
    const request = deferred<TestResult>()
    testSession.mockReturnValueOnce(request.promise)
    const view = render(<SessionForm open onClose={() => {}} session={mockSession} />)

    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    view.rerender(<SessionForm open={false} onClose={() => {}} session={mockSession} />)
    view.rerender(<SessionForm open onClose={() => {}} session={mockSession} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled())

    await act(async () => {
      request.resolve({
        ok: true,
        server_version: '8.4.0',
        latency_ms: 1,
        databases: [],
      })
      await request.promise
    })
    expect(screen.queryByText(/Connected!/)).not.toBeInTheDocument()
  })

  it('ignores a test rejection that belongs to a previous open', async () => {
    const request = deferred<TestResult>()
    testSession.mockReturnValueOnce(request.promise)
    const view = render(<SessionForm open onClose={() => {}} session={mockSession} />)

    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    view.rerender(<SessionForm open={false} onClose={() => {}} session={mockSession} />)
    view.rerender(<SessionForm open onClose={() => {}} session={mockSession} />)
    await act(async () => {
      request.reject(new Error('late test failure'))
      await request.promise.catch(() => {})
    })
    expect(screen.queryByText('late test failure')).not.toBeInTheDocument()
  })

  it('fetches databases and supports selecting and clearing all', async () => {
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)

    expect(screen.getByText(/Click Fetch to load/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByText('app_db')).toBeInTheDocument()
    expect(screen.getByText('analytics')).toBeInTheDocument()
    expect(screen.getByText('No selection — all databases will be shown')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'app_db' }))
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(screen.getByText('No selection — all databases will be shown')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'analytics' }))
    await user.click(screen.getByRole('checkbox', { name: 'analytics' }))
    expect(screen.getByText('No selection — all databases will be shown')).toBeInTheDocument()
  })

  it('announces a database fetch while its list is empty', async () => {
    const request = deferred<TestResult>()
    vi.mocked(api.probeConnection).mockReturnValueOnce(request.promise)
    const user = userEvent.setup()
    render(<SessionForm open onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(screen.getByRole('status')).toHaveTextContent('Fetching databases…')
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled()

    request.resolve({
      ok: true,
      server_version: '8.4.0',
      latency_ms: 1,
      databases: undefined as unknown as string[],
    })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText(/Click Fetch to load/)).toBeInTheDocument()
  })

  it('filters fetched databases through a managed allowlist', async () => {
    testSession.mockResolvedValueOnce({
      ok: true,
      server_version: '8.4.0',
      latency_ms: 1,
      databases: ['app_db', 'analytics', 'other'],
    })
    const user = userEvent.setup()
    render(
      <SessionForm
        open
        onClose={() => {}}
        session={managed({
          managed_selected_databases: ['app_db'],
          selected_databases: ['app_db', 'analytics'],
        })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByRole('checkbox', { name: 'app_db' })).toBeChecked()
    expect(screen.queryByText('analytics')).not.toBeInTheDocument()
    expect(screen.queryByText('other')).not.toBeInTheDocument()
    expect(screen.getByText(/only databases on the administrator's allowed list/)).toBeInTheDocument()
  })

  it('offers every fetched database when a managed session has no allowlist', async () => {
    testSession.mockResolvedValueOnce({
      ok: true,
      server_version: '8.4.0',
      latency_ms: 1,
      databases: ['app_db', 'analytics'],
    })
    const user = userEvent.setup()
    render(
      <SessionForm
        open
        onClose={() => {}}
        session={managed({ managed_selected_databases: [] })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByRole('checkbox', { name: 'app_db' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'analytics' })).toBeInTheDocument()
    expect(screen.queryByText(/only databases on/)).not.toBeInTheDocument()
  })

  it('shows explicit and fallback database-fetch failures', async () => {
    testSession.mockResolvedValueOnce({
      ok: false,
      error: 'Not authorized',
      latency_ms: 1,
      databases: [],
    })
    const user = userEvent.setup()
    const view = render(<SessionForm open onClose={() => {}} session={mockSession} />)

    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized')

    testSession.mockResolvedValueOnce({
      ok: false,
      error: null,
      latency_ms: 1,
      databases: [],
    })
    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection failed')
    view.unmount()
  })

  it('shows a database-fetch exception and rejects an invalid port first', async () => {
    const user = userEvent.setup()
    const view = render(<SessionForm open onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '0' } })
    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Port must be a number between 1 and 65535.',
    )
    expect(api.probeConnection).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '3306' } })
    vi.mocked(api.probeConnection).mockRejectedValueOnce(new Error('DNS failure'))
    await user.click(screen.getByRole('button', { name: 'Fetch' }))
    expect(await screen.findByText('Error: DNS failure')).toBeInTheDocument()
    view.unmount()
  })

  it('ignores a database fetch that finishes after a close and reopen', async () => {
    const request = deferred<TestResult>()
    vi.mocked(api.probeConnection).mockReturnValueOnce(request.promise)
    const view = render(<SessionForm open onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    view.rerender(<SessionForm open={false} onClose={() => {}} />)
    view.rerender(<SessionForm open onClose={() => {}} />)
    await act(async () => {
      request.resolve({
        ok: true,
        server_version: '8.4.0',
        latency_ms: 1,
        databases: ['late_db'],
      })
      await request.promise
    })
    expect(screen.queryByText('late_db')).not.toBeInTheDocument()
  })

  it('ignores a database-fetch rejection that belongs to a previous open', async () => {
    const request = deferred<TestResult>()
    vi.mocked(api.probeConnection).mockReturnValueOnce(request.promise)
    const view = render(<SessionForm open onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    view.rerender(<SessionForm open={false} onClose={() => {}} />)
    view.rerender(<SessionForm open onClose={() => {}} />)
    await act(async () => {
      request.reject(new Error('late fetch failure'))
      await request.promise.catch(() => {})
    })
    expect(screen.queryByText(/late fetch failure/)).not.toBeInTheDocument()
  })
})
