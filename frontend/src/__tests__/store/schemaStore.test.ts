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

  describe('invalidation fences in-flight requests', () => {
    it('drops a tables response requested before invalidateTablesForDb', async () => {
      let release = () => {}
      const arrived = new Promise<void>(resolve => { release = resolve })
      let requests = 0
      const staleTables = mockTables.map(t => ({ ...t, name: 'stale_table' }))
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases/${DB}/tables`, async () => {
          requests += 1
          if (requests === 1) await arrived
          return HttpResponse.json(requests === 1 ? staleTables : mockTables)
        })
      )
      const key = `${SESSION}/${DB}`

      const stale = useSchemaStore.getState().loadTables(SESSION, DB)
      useSchemaStore.getState().invalidateTablesForDb(SESSION, DB)
      release()

      // Callers still get the fetched value; only the cache write is dropped.
      expect(await stale).toEqual(staleTables)
      expect(useSchemaStore.getState().tables[key]).toBeUndefined()

      // The next read starts a fresh request instead of reusing the stale promise.
      const fresh = await useSchemaStore.getState().loadTables(SESSION, DB)
      expect(requests).toBe(2)
      expect(fresh).toEqual(mockTables)
      expect(useSchemaStore.getState().tables[key]).toEqual(mockTables)
    })

    it('drops a databases response requested before invalidateSession', async () => {
      let release = () => {}
      const arrived = new Promise<void>(resolve => { release = resolve })
      let requests = 0
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases`, async () => {
          requests += 1
          if (requests === 1) await arrived
          return HttpResponse.json(requests === 1 ? ['stale_db'] : mockDatabases)
        })
      )

      const stale = useSchemaStore.getState().loadDatabases(SESSION)
      useSchemaStore.getState().invalidateSession(SESSION)
      release()

      expect(await stale).toEqual(['stale_db'])
      expect(useSchemaStore.getState().databases[SESSION]).toBeUndefined()

      const fresh = await useSchemaStore.getState().loadDatabases(SESSION)
      expect(requests).toBe(2)
      expect(fresh).toEqual(mockDatabases)
    })

    it('clears loadingTables when invalidateTablesForDb abandons an in-flight load', async () => {
      let release = () => {}
      const arrived = new Promise<void>(resolve => { release = resolve })
      const staleTables = mockTables.map(t => ({ ...t, name: 'stale_table' }))
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases/${DB}/tables`, async () => {
          await arrived
          return HttpResponse.json(staleTables)
        })
      )
      const key = `${SESSION}/${DB}`

      const stale = useSchemaStore.getState().loadTables(SESSION, DB)
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(true)

      useSchemaStore.getState().invalidateTablesForDb(SESSION, DB)

      // No request is in flight for this key anymore, so the indicator must go.
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(false)

      release()
      expect(await stale).toEqual(staleTables)
      expect(useSchemaStore.getState().tables[key]).toBeUndefined()
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(false)
    })

    it('clears loadingDbs when invalidateSession abandons an in-flight load', async () => {
      let release = () => {}
      const arrived = new Promise<void>(resolve => { release = resolve })
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases`, async () => {
          await arrived
          return HttpResponse.json(['stale_db'])
        })
      )

      const stale = useSchemaStore.getState().loadDatabases(SESSION)
      expect(useSchemaStore.getState().loadingDbs.has(SESSION)).toBe(true)

      useSchemaStore.getState().invalidateSession(SESSION)

      expect(useSchemaStore.getState().loadingDbs.has(SESSION)).toBe(false)

      release()
      expect(await stale).toEqual(['stale_db'])
      expect(useSchemaStore.getState().databases[SESSION]).toBeUndefined()
      expect(useSchemaStore.getState().loadingDbs.has(SESSION)).toBe(false)
    })

    it('keeps loadingTables set while a newer load owns a key a stale batch was invalidated from', async () => {
      let releaseBatch = () => {}
      const batchArrived = new Promise<void>(resolve => { releaseBatch = resolve })
      let releaseSingle = () => {}
      const singleArrived = new Promise<void>(resolve => { releaseSingle = resolve })
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/tables`, async () => {
          await batchArrived
          return HttpResponse.json({ [DB]: mockTables })
        }),
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases/${DB}/tables`, async () => {
          await singleArrived
          return HttpResponse.json(mockTables)
        }),
      )
      const key = `${SESSION}/${DB}`

      const staleBatch = useSchemaStore.getState().loadTablesBatch(SESSION, [DB])
      useSchemaStore.getState().invalidateTablesForDb(SESSION, DB)
      const fresh = useSchemaStore.getState().loadTables(SESSION, DB)
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(true)

      // The abandoned batch settles first: the newer request is still running,
      // so the schema must keep its spinner.
      releaseBatch()
      await staleBatch
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(true)
      expect(useSchemaStore.getState().tables[key]).toBeUndefined()

      releaseSingle()
      await fresh
      expect(useSchemaStore.getState().loadingTables.has(key)).toBe(false)
      expect(useSchemaStore.getState().tables[key]).toEqual(mockTables)
    })

    it('records the failure reason and leaves the listing unset', async () => {
      // The shared reset helper leaves dbErrors alone, so clear it here.
      useSchemaStore.setState({ databases: {}, dbErrors: {} })
      server.use(
        http.get(`http://localhost/api/v1/sessions/${SESSION}/databases`, () =>
          HttpResponse.json({ detail: 'boom' }, { status: 500 })
        )
      )

      const dbs = await useSchemaStore.getState().loadDatabases(SESSION)

      expect(dbs).toEqual([])
      expect(useSchemaStore.getState().databases[SESSION]).toBeUndefined()
      expect(useSchemaStore.getState().dbErrors[SESSION]).toBeTruthy()
    })
  })
})

describe('database listing failures', () => {
  it('records why a listing failed instead of rendering an empty tree', async () => {
    const { server } = await import('../server')
    const { http, HttpResponse } = await import('msw')
    server.use(
      http.get('http://localhost/api/v1/sessions/:id/databases', () =>
        HttpResponse.json({ detail: 'Database connection failed' }, { status: 502 })
      )
    )

    const { useSchemaStore } = await import('../../store/schemaStore')
    useSchemaStore.setState({ databases: {}, dbErrors: {} })

    const result = await useSchemaStore.getState().loadDatabases('session-broken')

    expect(result).toEqual([])
    // The tree shows this text; without it an unreachable connection looked
    // exactly like a connection with no schemas.
    expect(useSchemaStore.getState().dbErrors['session-broken']).toBeTruthy()
  })

  it('clears the recorded error once a listing succeeds', async () => {
    const { server } = await import('../server')
    const { http, HttpResponse } = await import('msw')
    const { useSchemaStore } = await import('../../store/schemaStore')

    server.use(
      http.get('http://localhost/api/v1/sessions/:id/databases', () =>
        HttpResponse.json(['app_db'])
      )
    )
    useSchemaStore.setState({ databases: {}, dbErrors: { 'session-ok': 'stale failure' } })

    await useSchemaStore.getState().loadDatabases('session-ok')

    expect(useSchemaStore.getState().dbErrors['session-ok']).toBeUndefined()
    expect(useSchemaStore.getState().databases['session-ok']).toEqual(['app_db'])
  })
})
