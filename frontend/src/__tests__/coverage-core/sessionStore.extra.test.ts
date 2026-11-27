import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'

const BASE = 'http://localhost/api/v1'

function reset() {
  localStorage.clear()
  useSessionStore.setState({
    sessions: [],
    loading: false,
    error: null,
    activeSessionId: null,
  })
}

beforeEach(reset)

describe('session active-selection rules', () => {
  it('keeps the active session when the refreshed list still contains it', async () => {
    const other = { ...mockSession, id: 'other' }
    useSessionStore.setState({ activeSessionId: other.id })
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession, other])))

    await useSessionStore.getState().loadSessions()

    expect(useSessionStore.getState().activeSessionId).toBe(other.id)
  })

  it('selects the marked default when no active session survives', async () => {
    const fallback = { ...mockSession, id: 'fallback' }
    const preferred = { ...mockSession, id: 'preferred', is_default: true }
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([fallback, preferred])))

    await useSessionStore.getState().loadSessions()

    expect(useSessionStore.getState().activeSessionId).toBe('preferred')
  })

  it('selects the first session when no default is marked', async () => {
    const first = { ...mockSession, id: 'first' }
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([
      first,
      { ...mockSession, id: 'second' },
    ])))

    await useSessionStore.getState().loadSessions()

    expect(useSessionStore.getState().activeSessionId).toBe('first')
  })

  it('clears the active session when the server returns none', async () => {
    useSessionStore.setState({ activeSessionId: 'stale' })
    server.use(http.get(`${BASE}/sessions`, () => HttpResponse.json([])))

    await useSessionStore.getState().loadSessions()

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      activeSessionId: null,
      loading: false,
      error: null,
    })
  })
})

describe('session update and test operations', () => {
  it('replaces only the matching session and preserves the others', async () => {
    const other = { ...mockSession, id: 'other', name: 'Other DB' }
    useSessionStore.setState({ sessions: [mockSession, other] })
    server.use(
      http.put(`${BASE}/sessions/${mockSession.id}`, () =>
        HttpResponse.json({ ...mockSession, name: 'Updated' })
      ),
    )

    const updated = await useSessionStore.getState().updateSession(
      mockSession.id,
      { name: 'Updated' },
    )

    expect(updated.name).toBe('Updated')
    const [changed, unchanged] = useSessionStore.getState().sessions
    expect(changed).toMatchObject({ id: mockSession.id, name: 'Updated' })
    expect(unchanged).toEqual(other)
  })

  it('returns connection test details from the server', async () => {
    const result = await useSessionStore.getState().testSession(mockSession.id)

    expect(result).toMatchObject({
      ok: true,
      server_version: '8.0.0',
      databases: ['app_db', 'analytics'],
    })
  })
})
