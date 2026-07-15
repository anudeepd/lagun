import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import TabBar from '../../components/layout/TabBar'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'

describe('TabBar', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ activeSessionId: null })
  })

  it('prevents the right-button press from selecting tab text', () => {
    useTabStore.setState({
      tabs: [{ id: 'tab-1', type: 'query', label: 'Query', sessionId: 'session-1' }],
      activeTabId: 'tab-1',
    })

    render(<TabBar />)

    expect(fireEvent.mouseDown(screen.getByRole('tab', { name: /query/i }), { button: 2 })).toBe(false)
  })
})
