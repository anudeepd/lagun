import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from '../../components/ui/CommandPalette'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'

afterEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
})

describe('CommandPalette commands', () => {
  it('lists table and database-specific tab commands even without a session', () => {
    useTabStore.setState({
      tabs: [
        {
          id: 'table-1',
          type: 'table',
          label: 'users',
          sessionId: 'session-1',
          database: 'app',
          table: 'users',
        },
        {
          id: 'query-1',
          type: 'query',
          label: 'Analytics query',
          sessionId: 'session-1',
          database: 'analytics',
        },
      ],
      activeTabId: 'table-1',
    })
    render(<CommandPalette open onClose={() => {}} />)

    expect(screen.queryByRole('option', { name: /New query tab/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Switch to users/ })).toHaveTextContent('app.users')
    expect(screen.getByRole('option', { name: /Switch to Analytics query/ }))
      .toHaveTextContent('analytics')
  })

  it('falls back to the active-connection label and opens a new query', () => {
    const onClose = vi.fn()
    useSessionStore.setState({ sessions: [], activeSessionId: 'missing-session' })
    render(<CommandPalette open onClose={onClose} />)

    const newQuery = screen.getByRole('option', { name: /New query tab/ })
    expect(newQuery).toHaveTextContent('Active connection')

    fireEvent.click(newQuery)

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      type: 'query',
      sessionId: 'missing-session',
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
