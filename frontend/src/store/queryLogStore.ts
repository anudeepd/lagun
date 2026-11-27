import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { randomId } from '../utils/randomId'

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
  cancelled?: boolean
  bulk?: {
    statementCount: number
    operationCounts: Record<string, number>
    rolledBack: boolean
    failedStatementIndex?: number | null
    fullSql?: string
  }
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
          { ...entry, id: randomId(), timestamp: new Date().toISOString() },
          ...s.entries,
        ].slice(0, 100),
      })),

      clearLog: () => set({ entries: [] }),
    }),
    {
      name: 'lagun-query-log',
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        if (version < 3) {
          const s = persistedState as { entries?: { sql: string }[] }
          if (s.entries) {
            s.entries = s.entries.slice(0, 50)
          }
        }
        return persistedState as Partial<QueryLogState>
      },
      partialize: (s) => ({
        entries: s.entries.slice(0, 50).map(entry => entry.bulk?.fullSql
          ? { ...entry, bulk: { ...entry.bulk, fullSql: undefined } }
          : entry),
      }),
    }
  )
)
