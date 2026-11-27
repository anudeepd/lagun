import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Sidebar from '../../components/layout/Sidebar'
import { useSessionStore } from '../../store/sessionStore'
import { useServerConfigStore } from '../../store/serverConfigStore'
import { mockSession } from '../handlers'
import { submitLdapLogout } from '../../utils/authRedirect'

vi.mock('../../utils/authRedirect', () => ({
  submitLdapLogout: vi.fn(),
}))

vi.mock('../../components/sessions/SessionList', () => ({
  default: () => <div>Session list stub</div>,
}))

vi.mock('../../components/schema/SchemaTree', () => ({
  default: ({ sessionId, selectedDatabases }: {
    sessionId: string
    selectedDatabases?: string[]
  }) => (
    <div data-testid="schema-tree">
      {sessionId}:{selectedDatabases?.join(',') ?? 'none'}
    </div>
  ),
}))

function dialogStub(name: string) {
  return ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid={`${name}-dialog`} data-open={String(open)}>
      <button type="button" onClick={onClose}>close {name}</button>
    </div>
  )
}

vi.mock('../../components/sessions/SessionForm', () => ({
  default: dialogStub('session-form'),
}))
vi.mock('../../components/sessions/ConfigExportDialog', () => ({
  default: dialogStub('config-export'),
}))
vi.mock('../../components/sessions/ConfigImportDialog', () => ({
  default: dialogStub('config-import'),
}))

describe('Sidebar', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [mockSession],
      activeSessionId: null,
      loading: false,
      error: null,
    })
    useServerConfigStore.setState({ ldapEnabled: false, isAdmin: false })
  })

  afterEach(() => {
    cleanup()
    document.querySelectorAll('form[action="/_auth/logout"]').forEach(node => node.remove())
    vi.clearAllMocks()
  })

  it('opens and closes each connection dialog', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('session-form-dialog')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('config-export-dialog')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('config-import-dialog')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'New connection' }))
    expect(screen.getByTestId('session-form-dialog')).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close session-form' }))
    expect(screen.getByTestId('session-form-dialog')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Export connections' }))
    expect(screen.getByTestId('config-export-dialog')).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close config-export' }))
    expect(screen.getByTestId('config-export-dialog')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Import connections' }))
    expect(screen.getByTestId('config-import-dialog')).toHaveAttribute('data-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'close config-import' }))
    expect(screen.getByTestId('config-import-dialog')).toHaveAttribute('data-open', 'false')
  })

  it('passes the active session selection to the schema tree', () => {
    useSessionStore.setState({ activeSessionId: mockSession.id })
    const view = render(<Sidebar />)

    expect(screen.getByTestId('schema-tree')).toHaveTextContent(`${mockSession.id}:`)

    useSessionStore.setState({
      sessions: [{ ...mockSession, selected_databases: ['app_db'] }],
    })
    view.rerender(<Sidebar />)
    expect(screen.getByTestId('schema-tree')).toHaveTextContent(`${mockSession.id}:app_db`)
  })

  it('leaves the schema tree out when no connection is active or found', () => {
    const view = render(<Sidebar />)
    expect(screen.queryByTestId('schema-tree')).not.toBeInTheDocument()

    useSessionStore.setState({ activeSessionId: 'missing-session' })
    view.rerender(<Sidebar />)
    expect(screen.getByTestId('schema-tree')).toHaveTextContent('missing-session:none')
  })

  it('submits LDAP logout only when authentication is enabled', () => {
    const view = render(<Sidebar />)
    expect(screen.queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument()

    useServerConfigStore.setState({ ldapEnabled: true })
    view.rerender(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))

    const form = document.querySelector<HTMLFormElement>('form[action="/_auth/logout"]')
    expect(form).not.toBeNull()
    expect(form?.method).toBe('post')
    expect(submitLdapLogout).toHaveBeenCalledWith(form)
  })
})
