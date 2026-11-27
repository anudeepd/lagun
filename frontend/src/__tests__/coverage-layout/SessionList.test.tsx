import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionList from '../../components/sessions/SessionList'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import { mockSession } from '../handlers'
import type { Session } from '../../types'

vi.mock('../../components/sessions/SessionForm', () => ({
  default: ({ open, session, onClose }: {
    open: boolean
    session?: Session
    onClose: () => void
  }) => (
    <div data-testid="edit-form" data-open={String(open)}>
      {session?.name ?? 'none'}
      <button type="button" onClick={onClose}>close edit</button>
    </div>
  ),
}))

const alpha: Session = { ...mockSession, id: 'alpha', name: 'Alpha' }
const bravo: Session = { ...mockSession, id: 'bravo', name: 'Bravo', host: 'db.example' }
const managed: Session = {
  ...mockSession,
  id: 'managed',
  name: 'Shared',
  managed: true,
  managed_selected_databases: ['app_db'],
}

describe('SessionList coverage', () => {
  const deleteSession = vi.fn()
  const setActiveSession = vi.fn()
  const openQueryTab = vi.fn()

  beforeEach(() => {
    deleteSession.mockReset().mockResolvedValue(undefined)
    setActiveSession.mockReset()
    openQueryTab.mockReset()
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      loading: false,
      error: null,
      deleteSession,
      setActiveSession,
    })
    useTabStore.setState({ openQueryTab })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the loading state before the first session arrives', () => {
    useSessionStore.setState({ loading: true, sessions: [] })
    render(<SessionList />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading connections…')
  })

  it('shows the empty state once loading finishes', () => {
    render(<SessionList />)
    expect(screen.getByText('No connections yet.')).toBeInTheDocument()
  })

  it('still lists existing sessions while a refresh is loading', () => {
    useSessionStore.setState({ loading: true, sessions: [alpha] })
    render(<SessionList />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('distinguishes the active connection and activates another row', async () => {
    useSessionStore.setState({ sessions: [alpha, bravo], activeSessionId: alpha.id })
    const user = userEvent.setup()
    render(<SessionList />)

    expect(screen.getByRole('button', { name: /Alpha localhost/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('button', { name: /Bravo db.example/ })).not.toHaveAttribute(
      'aria-current',
    )

    await user.click(screen.getByRole('button', { name: /Bravo db.example/ }))
    expect(setActiveSession).toHaveBeenCalledWith(bravo.id)
  })

  it('opens, toggles, and dismisses an unmanaged connection menu', () => {
    useSessionStore.setState({ sessions: [alpha] })
    render(<SessionList />)

    const actions = screen.getByRole('button', { name: 'Actions for Alpha' })
    fireEvent.click(actions)
    expect(actions).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Actions for Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'New Query' })).toBeInTheDocument()

    fireEvent.click(actions)
    expect(actions).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(actions)
    fireEvent.mouseLeave(screen.getByRole('menu', { name: 'Actions for Alpha' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens a query tab for an unmanaged connection', () => {
    useSessionStore.setState({ sessions: [alpha] })
    render(<SessionList />)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Query' }))

    expect(openQueryTab).toHaveBeenCalledWith(alpha.id)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens Edit with the selected connection and closes it', () => {
    useSessionStore.setState({ sessions: [alpha] })
    render(<SessionList />)

    expect(screen.getByTestId('edit-form')).toHaveAttribute('data-open', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    expect(screen.getByTestId('edit-form')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('edit-form')).toHaveTextContent('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'close edit' }))
    expect(screen.getByTestId('edit-form')).toHaveAttribute('data-open', 'false')
  })

  it('deletes a personal connection after confirmation', async () => {
    useSessionStore.setState({ sessions: [alpha] })
    const user = userEvent.setup()
    render(<SessionList />)

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByRole('alertdialog', { name: 'Delete Connection' })).toBeInTheDocument()
    expect(screen.getByText(/Delete connection "Alpha"/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(alpha.id))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('removes a managed connection and omits connection-local actions', async () => {
    useSessionStore.setState({ sessions: [managed] })
    const user = userEvent.setup()
    render(<SessionList />)

    await user.click(screen.getByRole('button', { name: 'Actions for Shared' }))
    expect(screen.queryByRole('menuitem', { name: 'New Query' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }))

    expect(screen.getByText(/Other users keep access/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(managed.id))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('can cancel a delete without calling the store', async () => {
    useSessionStore.setState({ sessions: [alpha] })
    const user = userEvent.setup()
    render(<SessionList />)

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(deleteSession).not.toHaveBeenCalled()
  })
})
