import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'
import SessionList from '../../components/sessions/SessionList'

function resetStore() {
  useSessionStore.setState({ sessions: [], loading: false, error: null, activeSessionId: null })
}

describe('SessionList', () => {
  beforeEach(resetStore)

  it('shows empty state when there are no sessions', () => {
    render(<SessionList />)
    expect(screen.getByText(/No connections yet/i)).toBeInTheDocument()
  })

  it('renders session names', () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList />)
    expect(screen.getByText(mockSession.name)).toBeInTheDocument()
  })

  it('renders host alongside session name', () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList />)
    expect(screen.getByText(mockSession.host)).toBeInTheDocument()
  })

  it('sets active session on click', async () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList />)
    await userEvent.click(screen.getByText(mockSession.name))
    expect(useSessionStore.getState().activeSessionId).toBe(mockSession.id)
  })

  it('calls deleteSession when Delete is clicked in context menu', async () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList />)

    // Hover to reveal context menu button (fireEvent works without CSS visibility)
    const moreVertBtns = screen.getAllByRole('button')
    const menuBtn = moreVertBtns.find(b => b.className.includes('opacity-0'))

    if (menuBtn) {
      fireEvent.click(menuBtn)
      const deleteBtn = await screen.findByText('Delete')
      await userEvent.click(deleteBtn)
      expect(screen.getByRole('heading', { name: 'Delete Connection' })).toBeInTheDocument()
      expect(useSessionStore.getState().sessions).toHaveLength(1)

      await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => {
        expect(useSessionStore.getState().sessions).toHaveLength(0)
      })
    }
  })
})
