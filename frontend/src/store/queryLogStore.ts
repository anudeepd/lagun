import { create } from 'zustand'
import { persist } from 'zustand/middleware'

function uuid() {
  return crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
}

export interface QueryLogEntry {
  id: string
  timestamp: string
  sql: string
  sessionId: string
  database?: string
  rowCount?: number
  affectedRows?: number
  execTimeMs: number
  error?: string
}

interface QueryLogState {
  entries: QueryLogEntry[]
  addEntry: (entry: Omit<QueryLogEntry, 'id' | 'timestamp'>) => void
  clearLog: () => void
}

export const useQueryLogStore = create<QueryLogState>()(
  persist(
    (set) => ({
      entries: [],

      addEntry: (entry) => set(s => ({
        entries: [
          { ...entry, id: uuid(), timestamp: new Date().toISOString() },
          ...s.entries,
        ].slice(0, 200),
      })),

      clearLog: () => set({ entries: [] }),
    }),
    {
      name: 'lagun-query-log',
      version: 1,
      partialize: (s) => ({ entries: s.entries }),
    }
  )
)
