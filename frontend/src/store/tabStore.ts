import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Tab } from '../types'

function uuid() {
  return crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16))
}

function newId() { return `tab-${uuid()}` }

interface TabState {
  tabs: Tab[]
  activeTabId: string | null
  pendingSqls: Record<string, { sql: string; database?: string }>

  openQueryTab: (sessionId: string, database?: string) => void
  openQueryTabWithSql: (sessionId: string, sql: string, database?: string) => void
  openTableTab: (sessionId: string, database: string, table: string) => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  setActiveTab: (id: string) => void
  setSql: (tabId: string, sql: string) => void
  setTabDatabase: (tabId: string, database: string) => void
  injectSqlToTab: (tabId: string, sql: string, database?: string) => void
  consumePendingSql: (tabId: string) => void
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      pendingSqls: {},

      openQueryTab: (sessionId, database) => {
        const id = newId()
        const tab: Tab = {
          id,
          label: database ? `Query — ${database}` : 'Query',
          type: 'query',
          sessionId,
          database,
        }
        set(s => ({ tabs: [...s.tabs, tab], activeTabId: id }))
      },

      openQueryTabWithSql: (sessionId, sql, database) => {
        const id = newId()
        const tab: Tab = {
          id,
          label: database ? `Query — ${database}` : 'Query',
          type: 'query',
          sessionId,
          database,
          sql,
        }
        set(s => ({ tabs: [...s.tabs, tab], activeTabId: id }))
      },

      openTableTab: (sessionId, database, table) => {
        // Reuse existing tab for same table
        const existing = get().tabs.find(
          t => t.type === 'table' && t.sessionId === sessionId &&
               t.database === database && t.table === table
        )
        if (existing) {
          set({ activeTabId: existing.id })
          return
        }
        const id = newId()
        const tab: Tab = {
          id,
          label: table,
          type: 'table',
          sessionId,
          database,
          table,
        }
        set(s => ({ tabs: [...s.tabs, tab], activeTabId: id }))
      },

      closeTab: (id) => {
        set(s => {
          const tabs = s.tabs.filter(t => t.id !== id)
          let activeTabId = s.activeTabId
          if (activeTabId === id) {
            const idx = s.tabs.findIndex(t => t.id === id)
            activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null
          }
          return { tabs, activeTabId }
        })
      },

      setActiveTab: (id) => set({ activeTabId: id }),

      closeAllTabs: () => set({ tabs: [], activeTabId: null }),

      setSql: (tabId, sql) => set(s => ({
        tabs: s.tabs.map(t => t.id === tabId ? { ...t, sql } : t),
      })),

      setTabDatabase: (tabId, database) => set(s => ({
        tabs: s.tabs.map(t => t.id === tabId ? { ...t, database, label: `Query — ${database}` } : t),
      })),

      injectSqlToTab: (tabId, sql, database) => set(s => ({
        pendingSqls: { ...s.pendingSqls, [tabId]: { sql, database } },
      })),

      consumePendingSql: (tabId) => set(s => {
        const next = { ...s.pendingSqls }
        delete next[tabId]
        return { pendingSqls: next }
      }),
    }),
    {
      name: 'lagun-tabs',
      version: 2,
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId }),
    }
  )
)
