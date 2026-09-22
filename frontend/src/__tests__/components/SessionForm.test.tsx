import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'
import SessionForm from '../../components/sessions/SessionForm'

function resetStore() {
  useSessionStore.setState({ sessions: [], loading: false, error: null, activeSessionId: null })
}

describe('SessionForm', () => {
  beforeEach(resetStore)

  it('renders "New Connection" title when no session is passed', () => {
    render(<SessionForm open={true} onClose={() => {}} />)
    expect(screen.getByText('New Connection')).toBeInTheDocument()
  })

  it('renders "Edit Connection" title when a session is passed', () => {
    render(<SessionForm open={true} onClose={() => {}} session={mockSession} />)
    expect(screen.getByText('Edit Connection')).toBeInTheDocument()
  })

  it('pre-fills fields when editing an existing session', () => {
    render(<SessionForm open={true} onClose={() => {}} session={mockSession} />)
    expect(screen.getByDisplayValue(mockSession.name)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockSession.host)).toBeInTheDocument()
    expect(screen.getByDisplayValue(mockSession.username)).toBeInTheDocument()
  })

  it('does not pre-fill password field when editing', () => {
    render(<SessionForm open={true} onClose={() => {}} session={mockSession} />)
    const passwordInput = screen.getByPlaceholderText('(unchanged)')
    expect(passwordInput).toHaveValue('')
  })

  it('shows default values for a new connection', () => {
    render(<SessionForm open={true} onClose={() => {}} />)
    expect(screen.getByDisplayValue('localhost')).toBeInTheDocument()
    expect(screen.getByDisplayValue('3306')).toBeInTheDocument()
    expect(screen.getByDisplayValue('root')).toBeInTheDocument()
  })

  it('does not render when open is false', () => {
    render(<SessionForm open={false} onClose={() => {}} />)
    expect(screen.queryByText('New Connection')).not.toBeInTheDocument()
  })

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn()
    render(<SessionForm open={true} onClose={onClose} />)
    await userEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls createSession and closes on successful save', async () => {
    const onClose = vi.fn()
    render(<SessionForm open={true} onClose={onClose} />)

    await userEvent.type(screen.getByPlaceholderText('My Database'), 'New DB')

    await userEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(useSessionStore.getState().sessions).toHaveLength(1)
  })

  it('shows error message when save fails', async () => {
    server.use(
      http.post('http://localhost/api/v1/sessions', () =>
        HttpResponse.json({ detail: 'Duplicate name' }, { status: 422 })
      )
    )
    render(<SessionForm open={true} onClose={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText('My Database'), 'Existing DB')
    await userEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(screen.getByText(/Duplicate name|Error/i)).toBeInTheDocument())
  })

  it('shows connection test result when Test is clicked', async () => {
    render(<SessionForm open={true} onClose={() => {}} />)
    await userEvent.click(screen.getByText('Test'))
    await waitFor(() => expect(screen.getByText(/Connected!/)).toBeInTheDocument())
  })

  it('shows error when test connection fails', async () => {
    server.use(
      http.post('http://localhost/api/v1/sessions/probe', () =>
        HttpResponse.json({ ok: false, error: 'Connection refused', latency_ms: 50, databases: [] })
      )
    )
    render(<SessionForm open={true} onClose={() => {}} />)
    await userEvent.click(screen.getByText('Test'))
    await waitFor(() => expect(screen.getByText('Connection refused')).toBeInTheDocument())
  })

  it('announces the database fetch it is waiting on', async () => {
    let release = () => {}
    const arrived = new Promise<void>(resolve => { release = resolve })
    server.use(
      http.post('http://localhost/api/v1/sessions/probe', async () => {
        await arrived
        return HttpResponse.json({ ok: true, server_version: '8.0.0', latency_ms: 5, databases: ['app_db'] })
      })
    )

    render(<SessionForm open={true} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Fetch' }))

    // The Fetch button spins in place; the empty list it is filling states why.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Fetching databases…'),
    )

    release()

    await waitFor(() => expect(screen.getByText('app_db')).toBeInTheDocument())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
