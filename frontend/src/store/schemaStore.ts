import { create } from 'zustand'
import { api } from '../api/client'
import type { TableInfo, ColumnInfo } from '../types'

interface SchemaState {
  // Map of sessionId → database list
  databases: Record<string, string[]>
  // Map of `${sessionId}/${db}` → table list
  tables: Record<string, TableInfo[]>
  // Map of `${sessionId}/${db}/${table}` → column list
  columns: Record<string, ColumnInfo[]>
  // Loading states
  loadingDbs: Set<string>
  loadingTables: Set<string>

  loadDatabases: (sessionId: string) => Promise<string[]>
  loadTables: (sessionId: string, db: string) => Promise<TableInfo[]>
  loadColumns: (sessionId: string, db: string, table: string) => Promise<ColumnInfo[]>
  invalidateSession: (sessionId: string) => void
  invalidateTable: (sessionId: string, db: string, table: string) => void
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  databases: {},
  tables: {},
  columns: {},
  loadingDbs: new Set(),
  loadingTables: new Set(),

  loadDatabases: async (sessionId) => {
    const { databases, loadingDbs } = get()
    if (databases[sessionId]) return databases[sessionId]
    if (loadingDbs.has(sessionId)) return []

    set(s => ({ loadingDbs: new Set([...s.loadingDbs, sessionId]) }))
    try {
      const dbs = await api.getDatabases(sessionId)
      set(s => ({
        databases: { ...s.databases, [sessionId]: dbs },
        loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
      }))
      return dbs
    } catch {
      set(s => ({
        loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
      }))
      return []
    }
  },

  loadTables: async (sessionId, db) => {
    const key = `${sessionId}/${db}`
    const { tables, loadingTables } = get()
    if (tables[key]) return tables[key]
    if (loadingTables.has(key)) return []

    set(s => ({ loadingTables: new Set([...s.loadingTables, key]) }))
    try {
      const tbls = await api.getTables(sessionId, db)
      set(s => ({
        tables: { ...s.tables, [key]: tbls },
        loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
      }))
      return tbls
    } catch {
      set(s => ({
        loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
      }))
      return []
    }
  },

  loadColumns: async (sessionId, db, table) => {
    const key = `${sessionId}/${db}/${table}`
    const { columns } = get()
    if (columns[key]) return columns[key]
    const cols = await api.getColumns(sessionId, db, table)
    set(s => ({ columns: { ...s.columns, [key]: cols } }))
    return cols
  },

  invalidateSession: (sessionId) => {
    set(s => {
      const databases = { ...s.databases }
      delete databases[sessionId]
      const tables = Object.fromEntries(
        Object.entries(s.tables).filter(([k]) => !k.startsWith(`${sessionId}/`))
      )
      const columns = Object.fromEntries(
        Object.entries(s.columns).filter(([k]) => !k.startsWith(`${sessionId}/`))
      )
      return { databases, tables, columns }
    })
  },

  invalidateTable: (sessionId, db, table) => {
    const key = `${sessionId}/${db}/${table}`
    set(s => {
      const columns = { ...s.columns }
      delete columns[key]
      return { columns }
    })
  },
}))
