import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'
import SessionList from '../../components/sessions/SessionList'

const sessionA = { ...mockSession, id: 'session-a', name: 'Alpha' }
const sessionB = { ...mockSession, id: 'session-b', name: 'Bravo' }

describe('SessionList action menu keyboard', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], loading: false, error: null, activeSessionId: null })
  })

  it('moves keyboard handling to the menu opened while another one is still exiting', async () => {
    useSessionStore.setState({ sessions: [sessionA, sessionB] })
    render(<SessionList />)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alpha' }))
    await screen.findByRole('menu', { name: 'Actions for Alpha' })

    // Opening Bravo's menu leaves Alpha's node mounted for its exit animation.
    // One ref object shared by both menus kept the keyboard effect bound to
    // Alpha's detached node, so Bravo's menu never took focus and its arrow
    // keys did nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bravo' }))
    const menuB = await screen.findByRole('menu', { name: 'Actions for Bravo' })
    const items = within(menuB).getAllByRole('menuitem')

    await waitFor(() => expect(items[0]).toHaveFocus())

    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(items[1]).toHaveFocus())
  })
})
