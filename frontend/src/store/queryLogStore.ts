import { create } from 'zustand'
import { persist } from 'zustand/middleware'

function uuid() {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  if (cryptoApi?.getRandomValues) {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ cryptoApi.getRandomValues!(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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
          { ...entry, id: uuid(), timestamp: new Date().toISOString() },
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
