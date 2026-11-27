import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import App from '../../App'
import { server } from '../server'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import { useServerConfigStore } from '../../store/serverConfigStore'

const controls = vi.hoisted(() => ({
  navigateToAdmin: () => {},
  closeAdmin: () => {},
  idleOptions: null as null | {
    enabled: boolean
    idleTimeoutSeconds: number
    onIdle: () => void
  },
  idleCleanup: vi.fn(),
}))

vi.mock('../../components/layout/AppLayout', () => ({
  default: (props: { navigateToAdmin: () => void }) => {
    controls.navigateToAdmin = props.navigateToAdmin
    return null
  },
}))

vi.mock('../../components/admin/AdminConsole', () => ({
  default: (props: { onClose: () => void }) => {
    controls.closeAdmin = props.onClose
    return null
  },
}))

vi.mock('../../components/presence/PresenceReporter', () => ({ default: () => null }))
vi.mock('../../components/ui/AuthRedirectOverlay', () => ({ default: () => null }))
vi.mock('../../components/ui/ToastViewport', () => ({ default: () => null }))
vi.mock('../../utils/authIdleTimer', () => ({
  startAuthIdleTimer: (options: typeof controls.idleOptions) => {
    controls.idleOptions = options
    return controls.idleCleanup
  },
}))
vi.mock('../../utils/authRedirect', () => ({
  redirectToLdapLogin: vi.fn(),
}))

const BASE = 'http://localhost/api/v1'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    loading: false,
    error: null,
  })
  useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
  useServerConfigStore.setState({
    ldapEnabled: false,
    isAdmin: false,
    ldapIdleTimeout: 0,
    queryMaxResultRows: 1_000_000,
  })
  controls.idleCleanup.mockClear()
  controls.idleOptions = null
})

afterEach(() => {
  cleanup()
  document.querySelectorAll('body > button').forEach(element => element.remove())
})

async function waitForSessions() {
  await waitFor(() => expect(useSessionStore.getState().sessions).toHaveLength(1))
}

describe('App session reconciliation', () => {
  it('clears a deleted active session and closes tabs for deleted sessions', async () => {
    useSessionStore.setState({ activeSessionId: 'deleted-session' })
    useTabStore.setState({
      tabs: [
        { id: 'deleted-tab', type: 'query', label: 'Deleted', sessionId: 'deleted-session' },
        { id: 'kept-tab', type: 'table', label: 'users', sessionId: mockSession.id, database: 'app', table: 'users' },
      ],
      activeTabId: 'deleted-tab',
    })
    server.use(
      http.get(`${BASE}/sessions`, () =>
        HttpResponse.json({ detail: 'session list unavailable' }, { status: 500 })
      ),
      http.get(`${BASE}/config/server`, () => HttpResponse.json({
        ldap_enabled: true,
        ldap_idle_timeout: 120,
        is_admin: false,
        query_max_result_rows: 500,
      })),
    )

    render(<App />)
    await waitFor(() => expect(useSessionStore.getState().error).not.toBeNull())

    expect(useSessionStore.getState().activeSessionId).toBeNull()
    expect(useTabStore.getState().tabs).toEqual([])
    expect(controls.idleOptions).toMatchObject({
      enabled: true,
      idleTimeoutSeconds: 120,
    })
    expect(controls.idleOptions?.onIdle).toBeTypeOf('function')
    expect(screen.getByRole('link', { name: 'Skip to main content' }))
      .toHaveAttribute('href', '#main-content')
  })

  it('keeps a valid active session and its tabs', async () => {
    useSessionStore.setState({ activeSessionId: mockSession.id })
    useTabStore.setState({
      tabs: [
        { id: 'kept-tab', type: 'query', label: 'Kept', sessionId: mockSession.id },
      ],
      activeTabId: 'kept-tab',
    })
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))

    render(<App />)
    await waitForSessions()

    expect(useSessionStore.getState().activeSessionId).toBe(mockSession.id)
    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(controls.idleOptions).toMatchObject({
      enabled: false,
      idleTimeoutSeconds: 0,
    })
  })
})

describe('App route navigation', () => {
  it('opens the admin route, closes it, and returns focus to a connected opener', async () => {
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))
    render(<App />)
    await waitForSessions()
    await waitFor(() => expect(screen.getByLabelText('Workspace route')).toHaveFocus())

    const opener = document.createElement('button')
    opener.textContent = 'Persistent opener'
    document.body.appendChild(opener)
    opener.focus()
    act(() => controls.navigateToAdmin())

    expect(window.location.pathname).toBe('/admin')
    expect(screen.getByLabelText('Admin console route')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Admin console route')).toHaveFocus())

    act(() => controls.closeAdmin())

    expect(window.location.pathname).toBe('/')
    expect(screen.getByLabelText('Workspace route')).toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('handles browser back and forward route changes', async () => {
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))
    render(<App />)
    await waitForSessions()

    window.history.pushState({}, '', '/admin')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.getByLabelText('Admin console route')).toBeInTheDocument()

    window.history.pushState({}, '', '/workspace')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.getByLabelText('Workspace route')).toBeInTheDocument()
  })

  it('starts on the admin route and focuses it when no opener was recorded', async () => {
    window.history.replaceState({}, '', '/admin')
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))
    render(<App />)
    await waitForSessions()

    const route = screen.getByLabelText('Admin console route')
    await waitFor(() => expect(route).toHaveFocus())
    expect(screen.queryByLabelText('Workspace route')).not.toBeInTheDocument()
  })

  it('uses route focus when the opener was not an element or is disconnected', async () => {
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))
    render(<App />)
    await waitForSessions()

    const activeElement = Object.getOwnPropertyDescriptor(document, 'activeElement')
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => null,
    })
    try {
      act(() => controls.navigateToAdmin())
    } finally {
      if (activeElement) Object.defineProperty(document, 'activeElement', activeElement)
      else delete (document as unknown as { activeElement?: unknown }).activeElement
    }
    act(() => controls.closeAdmin())

    await waitFor(() => expect(screen.getByLabelText('Workspace route')).toHaveFocus())
  })

  it('disposes the idle timer and popstate listener on unmount', async () => {
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])))
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<App />)
    await waitForSessions()

    unmount()

    expect(controls.idleCleanup).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function))
  })
})
