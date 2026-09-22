import { create } from 'zustand'
import { api } from '../api/client'
import type { TableInfo, ColumnInfo } from '../types'

// Module-level in-flight promise maps — not in Zustand state (which is only for UI indicators)
const _inflightDbs: Partial<Record<string, Promise<string[]>>> = {}
const _inflightTables: Partial<Record<string, Promise<TableInfo[]>>> = {}
// Keys with a batch table fetch in flight, so repeated keystrokes do not
// re-request the same schemas.
const _pendingTableBatches = new Set<string>()
const _inflightColumns: Partial<Record<string, Promise<ColumnInfo[]>>> = {}

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
  // Why a database listing failed, per session. A failed listing used to be
  // swallowed and rendered as an empty tree, which looks identical to a
  // connection that simply has no schemas.
  dbErrors: Record<string, string>

  loadDatabases: (sessionId: string) => Promise<string[]>
  loadTables: (sessionId: string, db: string) => Promise<TableInfo[]>
  loadTablesBatch: (sessionId: string, dbs: string[]) => Promise<void>
  loadColumns: (sessionId: string, db: string, table: string) => Promise<ColumnInfo[]>
  invalidateSession: (sessionId: string) => void
  invalidateTable: (sessionId: string, db: string, table: string) => void
  invalidateTablesForDb: (sessionId: string, db: string) => void
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  databases: {},
  tables: {},
  columns: {},
  loadingDbs: new Set(),
  loadingTables: new Set(),
  dbErrors: {},

  loadDatabases: async (sessionId) => {
    const { databases } = get()
    if (databases[sessionId]) return databases[sessionId]
    if (_inflightDbs[sessionId]) return _inflightDbs[sessionId]

    set(s => ({ loadingDbs: new Set([...s.loadingDbs, sessionId]) }))
    const promise = api.getDatabases(sessionId).then(dbs => {
      set(s => {
        const dbErrors = { ...s.dbErrors }
        delete dbErrors[sessionId]
        return {
          databases: { ...s.databases, [sessionId]: dbs },
          dbErrors,
          loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
        }
      })
      return dbs
    }).catch((error: unknown) => {
      set(s => ({
        dbErrors: { ...s.dbErrors, [sessionId]: error instanceof Error ? error.message : String(error) },
        loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
      }))
      return [] as string[]
    }).finally(() => { delete _inflightDbs[sessionId] })
    _inflightDbs[sessionId] = promise
    return promise
  },

  loadTables: async (sessionId, db) => {
    const key = `${sessionId}/${db}`
    const { tables } = get()
    if (tables[key]) return tables[key]
    if (_inflightTables[key]) return _inflightTables[key]

    set(s => ({ loadingTables: new Set([...s.loadingTables, key]) }))
    const promise = api.getTables(sessionId, db).then(tbls => {
      set(s => ({
        tables: { ...s.tables, [key]: tbls },
        loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
      }))
      return tbls
    }).catch(() => {
      set(s => ({
        loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
      }))
      return [] as TableInfo[]
    }).finally(() => { delete _inflightTables[key] })
    _inflightTables[key] = promise
    return promise
  },

  loadTablesBatch: async (sessionId, dbs) => {
    const { tables } = get()
    const wanted = [...new Set(dbs)].filter(db => {
      const key = `${sessionId}/${db}`
      return tables[key] === undefined && !_pendingTableBatches.has(key)
    })
    if (wanted.length === 0) return

    const keys = wanted.map(db => `${sessionId}/${db}`)
    const keySet = new Set(keys)
    keys.forEach(key => _pendingTableBatches.add(key))
    set(s => ({ loadingTables: new Set([...s.loadingTables, ...keys]) }))
    const finish = () => {
      keys.forEach(key => _pendingTableBatches.delete(key))
      set(s => ({ loadingTables: new Set([...s.loadingTables].filter(k => !keySet.has(k))) }))
    }
    try {
      const grouped = await api.getTablesBatch(sessionId, wanted)
      set(s => {
        const next = { ...s.tables }
        wanted.forEach(db => { next[`${sessionId}/${db}`] = grouped[db] ?? [] })
        return { tables: next }
      })
    } finally {
      // A failed batch leaves those schemas unknown, so they stay visible
      // under a search filter and can be retried.
      finish()
    }
  },

  loadColumns: async (sessionId, db, table) => {
    const key = `${sessionId}/${db}/${table}`
    const { columns } = get()
    if (columns[key]) return columns[key]
    if (_inflightColumns[key]) return _inflightColumns[key]

    const promise = api.getColumns(sessionId, db, table).then(cols => {
      set(s => ({ columns: { ...s.columns, [key]: cols } }))
      return cols
    }).catch(() => {
      return [] as ColumnInfo[]
    }).finally(() => { delete _inflightColumns[key] })
    _inflightColumns[key] = promise
    return promise
  },

  invalidateSession: (sessionId) => {
    set(s => {
      const databases = { ...s.databases }
      delete databases[sessionId]
      const dbErrors = { ...s.dbErrors }
      delete dbErrors[sessionId]
      const tables = Object.fromEntries(
        Object.entries(s.tables).filter(([k]) => !k.startsWith(`${sessionId}/`))
      )
      const columns = Object.fromEntries(
        Object.entries(s.columns).filter(([k]) => !k.startsWith(`${sessionId}/`))
      )
      return { databases, dbErrors, tables, columns }
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

  invalidateTablesForDb: (sessionId, db) => {
    const key = `${sessionId}/${db}`
    delete _inflightTables[key]
    set(s => {
      const tables = { ...s.tables }
      delete tables[key]
      return { tables }
    })
  },
}))
