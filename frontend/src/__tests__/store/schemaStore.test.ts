import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockDatabases, mockTables, mockColumns } from '../handlers'
import { useSchemaStore } from '../../store/schemaStore'

function resetStore() {
  useSchemaStore.setState({
    databases: {},
    tables: {},
    columns: {},
    loadingDbs: new Set(),
    loadingTables: new Set(),
  })
}

describe('schemaStore', () => {
  beforeEach(resetStore)

  const SESSION = 'session-1'
  const DB = 'app_db'
  const TABLE = 'users'

  describe('loadDatabases', () => {
    it('fetches and stores databases', async () => {
      const dbs = await useSchemaStore.getState().loadDatabases(SESSION)
      expect(dbs).toEqual(mockDatabases)
      expect(useSchemaStore.getState().databases[SESSION]).toEqual(mockDatabases)
    })

    it('returns cached result on second call without another fetch', async () => {
      await useSchemaStore.getState().loadDatabases(SESSION)
      // Override the handler to ensure a second fetch would return different data
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases`, () =>
          HttpResponse.json(['should_not_appear'])
        )
      )
      const dbs = await useSchemaStore.getState().loadDatabases(SESSION)
      expect(dbs).toEqual(mockDatabases) // still the cached value
    })

    it('returns empty array on API failure', async () => {
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases`, () =>
          HttpResponse.json({ detail: 'Not found' }, { status: 404 })
        )
      )
      const dbs = await useSchemaStore.getState().loadDatabases(SESSION)
      expect(dbs).toEqual([])
    })
  })

  describe('loadTables', () => {
    it('fetches and stores tables under the session/db key', async () => {
      const tables = await useSchemaStore.getState().loadTables(SESSION, DB)
      expect(tables).toEqual(mockTables)
      expect(useSchemaStore.getState().tables[`${SESSION}/${DB}`]).toEqual(mockTables)
    })
  })

  describe('loadColumns', () => {
    it('fetches and stores columns', async () => {
      const cols = await useSchemaStore.getState().loadColumns(SESSION, DB, TABLE)
      expect(cols).toEqual(mockColumns)
      expect(useSchemaStore.getState().columns[`${SESSION}/${DB}/${TABLE}`]).toEqual(mockColumns)
    })
  })

  describe('invalidateSession', () => {
    it('removes all cached data for the session', async () => {
      await useSchemaStore.getState().loadDatabases(SESSION)
      await useSchemaStore.getState().loadTables(SESSION, DB)
      await useSchemaStore.getState().loadColumns(SESSION, DB, TABLE)

      useSchemaStore.getState().invalidateSession(SESSION)

      const state = useSchemaStore.getState()
      expect(state.databases[SESSION]).toBeUndefined()
      expect(state.tables[`${SESSION}/${DB}`]).toBeUndefined()
      expect(state.columns[`${SESSION}/${DB}/${TABLE}`]).toBeUndefined()
    })

    it('does not affect data from other sessions', async () => {
      const OTHER = 'other-session'
      useSchemaStore.setState({ databases: { [SESSION]: ['db1'], [OTHER]: ['db2'] } })
      useSchemaStore.getState().invalidateSession(SESSION)
      expect(useSchemaStore.getState().databases[OTHER]).toEqual(['db2'])
    })
  })

  describe('invalidateTable', () => {
    it('removes only the specified table columns from cache', async () => {
      await useSchemaStore.getState().loadColumns(SESSION, DB, TABLE)
      await useSchemaStore.getState().loadColumns(SESSION, DB, 'orders')

      useSchemaStore.getState().invalidateTable(SESSION, DB, TABLE)

      const state = useSchemaStore.getState()
      expect(state.columns[`${SESSION}/${DB}/${TABLE}`]).toBeUndefined()
      expect(state.columns[`${SESSION}/${DB}/orders`]).toBeDefined()
    })
  })
})
