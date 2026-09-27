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

// Per-key generation counters, keyed exactly like the in-flight maps above. An
// invalidation bumps the key, and a loader that captured the old value drops
// its payload instead of refilling the entry it was invalidated from.
const _generations = new Map<string, number>()
const generationOf = (key: string): number => _generations.get(key) ?? 0

// Fencing alone is not enough: the in-flight promise (or pending batch) must
// also be forgotten, or the next read is handed that stale promise back
// instead of starting a fresh request. The keys never collide across maps, so
// clearing all of them is safe.
const forget = (key: string): void => {
  _generations.set(key, generationOf(key) + 1)
  delete _inflightDbs[key]
  delete _inflightTables[key]
  delete _inflightColumns[key]
  _pendingTableBatches.delete(key)
}

// Invalidation owns the loading indicator too: the request that would have
// cleared the flag is being abandoned, so leaving it set would wedge a spinner
// forever when nothing follows up with a reload.
const clearLoading = (
  s: Pick<SchemaState, 'loadingDbs' | 'loadingTables'>,
  keys: Iterable<string>
): { loadingDbs: Set<string>; loadingTables: Set<string> } => {
  const remove = new Set(keys)
  return {
    loadingDbs: new Set([...s.loadingDbs].filter(k => !remove.has(k))),
    loadingTables: new Set([...s.loadingTables].filter(k => !remove.has(k))),
  }
}

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

  // Resolving `[]` means failure, not "no databases"; the reason is recorded in
  // dbErrors, so a resolve never tells success from failure.
  loadDatabases: async (sessionId) => {
    const { databases } = get()
    if (databases[sessionId]) return databases[sessionId]
    if (_inflightDbs[sessionId]) return _inflightDbs[sessionId]

    const generation = generationOf(sessionId)
    set(s => ({ loadingDbs: new Set([...s.loadingDbs, sessionId]) }))
    const promise = api.getDatabases(sessionId).then(dbs => {
      // An invalidation after the request began owns the entry now; this
      // response is stale and must not refill it.
      if (generation === generationOf(sessionId)) {
        set(s => {
          const dbErrors = { ...s.dbErrors }
          delete dbErrors[sessionId]
          return {
            databases: { ...s.databases, [sessionId]: dbs },
            dbErrors,
            loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
          }
        })
      }
      return dbs
    }).catch((error: unknown) => {
      if (generation === generationOf(sessionId)) {
        set(s => ({
          dbErrors: { ...s.dbErrors, [sessionId]: error instanceof Error ? error.message : String(error) },
          loadingDbs: new Set([...s.loadingDbs].filter(x => x !== sessionId)),
        }))
      }
      return [] as string[]
    }).finally(() => {
      // Only this request may clear the entry: a newer one may have replaced it.
      if (_inflightDbs[sessionId] === promise) delete _inflightDbs[sessionId]
    })
    _inflightDbs[sessionId] = promise
    return promise
  },

  // Resolving `[]` means the fetch failed, so the resolved value alone never
  // tells success from failure.
  loadTables: async (sessionId, db) => {
    const key = `${sessionId}/${db}`
    const { tables } = get()
    if (tables[key]) return tables[key]
    if (_inflightTables[key]) return _inflightTables[key]

    const generation = generationOf(key)
    set(s => ({ loadingTables: new Set([...s.loadingTables, key]) }))
    const promise = api.getTables(sessionId, db).then(tbls => {
      // Dropped when an invalidation landed while this request was in flight.
      if (generation === generationOf(key)) {
        set(s => ({
          tables: { ...s.tables, [key]: tbls },
          loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
        }))
      }
      return tbls
    }).catch(() => {
      if (generation === generationOf(key)) {
        set(s => ({
          loadingTables: new Set([...s.loadingTables].filter(x => x !== key)),
        }))
      }
      return [] as TableInfo[]
    }).finally(() => {
      if (_inflightTables[key] === promise) delete _inflightTables[key]
    })
    _inflightTables[key] = promise
    return promise
  },

  // Resolving early means every schema failed, so the resolved value alone
  // never tells success from failure; failed schemas stay retryable.
  loadTablesBatch: async (sessionId, dbs) => {
    const { tables } = get()
    const wanted = [...new Set(dbs)].filter(db => {
      const key = `${sessionId}/${db}`
      return tables[key] === undefined && !_pendingTableBatches.has(key)
    })
    if (wanted.length === 0) return

    const keys = wanted.map(db => `${sessionId}/${db}`)
    const generations = new Map<string, number>(keys.map(key => [key, generationOf(key)]))
    keys.forEach(key => _pendingTableBatches.add(key))
    set(s => ({ loadingTables: new Set([...s.loadingTables, ...keys]) }))
    const finish = () => {
      // A schema invalidated mid-batch was already forgotten, and its loading
      // flag cleared; a newer load may own both now, so only drop what this
      // batch still owns. Clearing the flag unconditionally would hide the
      // spinner while that newer request is still in flight.
      const owned = keys.filter(key => generations.get(key) === generationOf(key))
      owned.forEach(key => _pendingTableBatches.delete(key))
      const ownedSet = new Set(owned)
      set(s => ({ loadingTables: new Set([...s.loadingTables].filter(k => !ownedSet.has(k))) }))
    }
    try {
      const grouped = await api.getTablesBatch(sessionId, wanted)
      set(s => {
        const next = { ...s.tables }
        wanted.forEach(db => {
          const key = `${sessionId}/${db}`
          // Schemas invalidated while the batch was in flight stay unset.
          if (generations.get(key) === generationOf(key)) next[key] = grouped[db] ?? []
        })
        return { tables: next }
      })
    } finally {
      // A failed batch leaves those schemas unknown, so they stay visible
      // under a search filter and can be retried.
      finish()
    }
  },

  // Resolving `[]` means the fetch failed, so the resolved value alone never
  // tells success from failure.
  loadColumns: async (sessionId, db, table) => {
    const key = `${sessionId}/${db}/${table}`
    const { columns } = get()
    if (columns[key]) return columns[key]
    if (_inflightColumns[key]) return _inflightColumns[key]

    const generation = generationOf(key)
    const promise = api.getColumns(sessionId, db, table).then(cols => {
      if (generation === generationOf(key)) {
        set(s => ({ columns: { ...s.columns, [key]: cols } }))
      }
      return cols
    }).catch(() => {
      return [] as ColumnInfo[]
    }).finally(() => {
      if (_inflightColumns[key] === promise) delete _inflightColumns[key]
    })
    _inflightColumns[key] = promise
    return promise
  },

  invalidateSession: (sessionId) => {
    // Forget every key the session owns: its own listing plus each table and
    // column key, whether cached, in flight, or queued in a pending batch.
    const prefix = `${sessionId}/`
    const forgotten = [sessionId]
    for (const key of Object.keys(_inflightTables)) if (key.startsWith(prefix)) forgotten.push(key)
    for (const key of Object.keys(_inflightColumns)) if (key.startsWith(prefix)) forgotten.push(key)
    for (const key of [..._pendingTableBatches]) if (key.startsWith(prefix)) forgotten.push(key)
    forgotten.forEach(forget)
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
      return { databases, dbErrors, tables, columns, ...clearLoading(s, forgotten) }
    })
  },

  invalidateTable: (sessionId, db, table) => {
    const key = `${sessionId}/${db}/${table}`
    forget(key)
    set(s => {
      const columns = { ...s.columns }
      delete columns[key]
      return { columns, ...clearLoading(s, [key]) }
    })
  },

  invalidateTablesForDb: (sessionId, db) => {
    const key = `${sessionId}/${db}`
    forget(key)
    set(s => {
      const tables = { ...s.tables }
      delete tables[key]
      return { tables, ...clearLoading(s, [key]) }
    })
  },
}))
