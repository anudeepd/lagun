import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api/client'
import type { Session, SessionCreate, SessionUpdate, TestResult } from '../types'

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  loading: boolean
  error: string | null

  loadSessions: () => Promise<void>
  setActiveSession: (id: string | null) => void
  createSession: (data: SessionCreate) => Promise<Session>
  updateSession: (id: string, data: SessionUpdate) => Promise<Session>
  deleteSession: (id: string) => Promise<void>
  testSession: (id: string) => Promise<TestResult>
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: null,
      loading: false,
      error: null,

      loadSessions: async () => {
        set({ loading: true, error: null })
        try {
          const sessions = await api.getSessions()
          set({ sessions, loading: false })
        } catch (e) {
          set({ error: String(e), loading: false })
        }
      },

      setActiveSession: (id) => set({ activeSessionId: id }),

      createSession: async (data) => {
        const session = await api.createSession(data)
        set(s => ({ sessions: [...s.sessions, session] }))
        return session
      },

      updateSession: async (id, data) => {
        const session = await api.updateSession(id, data)
        set(s => ({
          sessions: s.sessions.map(x => (x.id === id ? session : x)),
        }))
        return session
      },

      deleteSession: async (id) => {
        await api.deleteSession(id)
        set(s => ({
          sessions: s.sessions.filter(x => x.id !== id),
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
        }))
      },

      testSession: async (id) => {
        return api.testSession(id)
      },
    }),
    {
      name: 'lagun-session-ui',
      version: 1,
      partialize: (s) => ({ activeSessionId: s.activeSessionId }),
    }
  )
)
