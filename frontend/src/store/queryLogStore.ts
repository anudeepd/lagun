import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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
          { ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() },
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
