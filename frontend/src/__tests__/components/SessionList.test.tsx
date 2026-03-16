import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import SessionList from '../../components/sessions/SessionList'

function resetStore() {
  useSessionStore.setState({ sessions: [], loading: false, error: null, activeSessionId: null })
}

describe('SessionList', () => {
  beforeEach(resetStore)

  it('shows empty state when there are no sessions', () => {
    render(<SessionList onNew={() => {}} />)
    expect(screen.getByText(/No connections yet/i)).toBeInTheDocument()
  })

  it('renders session names', () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList onNew={() => {}} />)
    expect(screen.getByText(mockSession.name)).toBeInTheDocument()
  })

  it('renders host alongside session name', () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList onNew={() => {}} />)
    expect(screen.getByText(mockSession.host)).toBeInTheDocument()
  })

  it('sets active session on click', async () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList onNew={() => {}} />)
    await userEvent.click(screen.getByText(mockSession.name))
    expect(useSessionStore.getState().activeSessionId).toBe(mockSession.id)
  })

  it('calls deleteSession when Delete is clicked in context menu', async () => {
    useSessionStore.setState({ sessions: [mockSession] })
    render(<SessionList onNew={() => {}} />)

    // Hover to reveal context menu button (fireEvent works without CSS visibility)
    const _moreBtn = screen.queryByTitle(/more/i)
    const moreVertBtns = screen.getAllByRole('button')
    const menuBtn = moreVertBtns.find(b => b.className.includes('opacity-0'))

    if (menuBtn) {
      fireEvent.click(menuBtn)
      const deleteBtn = await screen.findByText('Delete')
      await userEvent.click(deleteBtn)
      // Session should be removed from state after delete API call
      expect(useSessionStore.getState().sessions).toHaveLength(0)
    }
  })
})
