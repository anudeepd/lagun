import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockSession } from '../handlers'
import { useSessionStore } from '../../store/sessionStore'

const BASE = 'http://localhost/api/v1'

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    loading: false,
    error: null,
    activeSessionId: null,
  })
}

describe('sessionStore', () => {
  beforeEach(resetStore)

  describe('loadSessions', () => {
    it('fetches sessions and stores them', async () => {
      await useSessionStore.getState().loadSessions()
      const { sessions, loading, error } = useSessionStore.getState()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].name).toBe('Test DB')
      expect(loading).toBe(false)
      expect(error).toBeNull()
    })

    it('sets error state on API failure', async () => {
      server.use(
        http.get(`${BASE}/sessions`, () => HttpResponse.json({ detail: 'Server error' }, { status: 500 }))
      )
      await useSessionStore.getState().loadSessions()
      const { sessions, error } = useSessionStore.getState()
      expect(sessions).toHaveLength(0)
      expect(error).toBeTruthy()
    })
  })

  describe('createSession', () => {
    it('appends new session to state', async () => {
      const data = {
        name: 'New', host: 'localhost', port: 3306,
        username: 'root', password: '',
        query_limit: 1000, ssl_enabled: false,
      }
      const session = await useSessionStore.getState().createSession(data)
      expect(session.name).toBe('Test DB') // mock always returns mockSession
      expect(useSessionStore.getState().sessions).toHaveLength(1)
    })

    it('throws when API returns an error', async () => {
      server.use(
        http.post(`${BASE}/sessions`, () => HttpResponse.json({ detail: 'Validation error' }, { status: 422 }))
      )
      await expect(
        useSessionStore.getState().createSession({ name: '', host: '', port: 3306, username: '', password: '', query_limit: 1000, ssl_enabled: false })
      ).rejects.toThrow()
    })
  })

  describe('updateSession', () => {
    it('replaces the session in state', async () => {
      useSessionStore.setState({ sessions: [mockSession] })
      server.use(
        http.put(`${BASE}/sessions/${mockSession.id}`, () =>
          HttpResponse.json({ ...mockSession, name: 'Updated Name' })
        )
      )
      const updated = await useSessionStore.getState().updateSession(mockSession.id, { name: 'Updated Name' })
      expect(updated.name).toBe('Updated Name')
      expect(useSessionStore.getState().sessions[0].name).toBe('Updated Name')
    })
  })

  describe('deleteSession', () => {
    it('removes session from state', async () => {
      useSessionStore.setState({ sessions: [mockSession], activeSessionId: mockSession.id })
      await useSessionStore.getState().deleteSession(mockSession.id)
      expect(useSessionStore.getState().sessions).toHaveLength(0)
    })

    it('clears activeSessionId when active session is deleted', async () => {
      useSessionStore.setState({ sessions: [mockSession], activeSessionId: mockSession.id })
      await useSessionStore.getState().deleteSession(mockSession.id)
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })

    it('keeps activeSessionId when a different session is deleted', async () => {
      const other = { ...mockSession, id: 'other-id' }
      useSessionStore.setState({ sessions: [mockSession, other], activeSessionId: mockSession.id })
      server.use(http.delete(`${BASE}/sessions/other-id`, () => new HttpResponse(null, { status: 204 })))
      await useSessionStore.getState().deleteSession('other-id')
      expect(useSessionStore.getState().activeSessionId).toBe(mockSession.id)
    })
  })

  describe('setActiveSession', () => {
    it('updates activeSessionId', () => {
      useSessionStore.getState().setActiveSession('abc')
      expect(useSessionStore.getState().activeSessionId).toBe('abc')
    })

    it('can be set to null', () => {
      useSessionStore.setState({ activeSessionId: 'abc' })
      useSessionStore.getState().setActiveSession(null)
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })
  })
})
