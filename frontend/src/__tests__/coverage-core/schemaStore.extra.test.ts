import { beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockColumns, mockDatabases, mockTables } from '../handlers'
import { useSchemaStore } from '../../store/schemaStore'

const BASE = 'http://localhost/api/v1'
let sequence = 0

function sessionId() {
  sequence += 1
  return `extra-${sequence}`
}

function reset() {
  useSchemaStore.setState({
    databases: {},
    tables: {},
    columns: {},
    rowKeys: {},
    loadingDbs: new Set(),
    loadingTables: new Set(),
    dbErrors: {},
  })
}

function deferred() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

beforeEach(reset)

describe('schema database request sharing and failure fences', () => {
  it('shares one in-flight database listing and then serves it from cache', async () => {
    const session = sessionId()
    const gate = deferred()
    let requests = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/databases`, async () => {
        requests += 1
        await gate.promise
        return HttpResponse.json(mockDatabases)
      }),
    )

    const first = useSchemaStore.getState().loadDatabases(session)
    const second = useSchemaStore.getState().loadDatabases(session)
    await vi.waitFor(() => expect(requests).toBe(1))
    expect(useSchemaStore.getState().loadingDbs.has(session)).toBe(true)

    gate.release()
    await expect(first).resolves.toEqual(mockDatabases)
    await expect(second).resolves.toEqual(mockDatabases)
    await useSchemaStore.getState().loadDatabases(session)

    expect(requests).toBe(1)
    expect(useSchemaStore.getState().loadingDbs.has(session)).toBe(false)
  })

  it('records a failed listing and still allows a retry', async () => {
    const session = sessionId()
    let attempts = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/databases`, () => {
        attempts += 1
        return attempts === 1
          ? HttpResponse.json({ detail: 'connection refused' }, { status: 500 })
          : HttpResponse.json(mockDatabases)
      }),
    )

    await expect(useSchemaStore.getState().loadDatabases(session)).resolves.toEqual([])
    expect(useSchemaStore.getState().dbErrors[session]).toContain('connection refused')
    expect(useSchemaStore.getState().loadingDbs.has(session)).toBe(false)

    await expect(useSchemaStore.getState().loadDatabases(session)).resolves.toEqual(mockDatabases)
    expect(useSchemaStore.getState().dbErrors[session]).toBeUndefined()
  })

  it('records a non-Error rejection reason', async () => {
    const session = sessionId()
    const getDatabases = vi.spyOn((await import('../../api/client')).api, 'getDatabases')
      .mockRejectedValueOnce('plain failure')

    try {
      await expect(useSchemaStore.getState().loadDatabases(session)).resolves.toEqual([])
      expect(useSchemaStore.getState().dbErrors[session]).toBe('plain failure')
    } finally {
      getDatabases.mockRestore()
    }
  })

  it('drops a database failure that arrives after invalidation', async () => {
    const session = sessionId()
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${session}/databases`, async () => {
        await gate.promise
        return HttpResponse.json({ detail: 'late failure' }, { status: 502 })
      }),
    )

    const request = useSchemaStore.getState().loadDatabases(session)
    useSchemaStore.getState().invalidateSession(session)
    gate.release()

    await expect(request).resolves.toEqual([])
    expect(useSchemaStore.getState().dbErrors[session]).toBeUndefined()
    expect(useSchemaStore.getState().loadingDbs.has(session)).toBe(false)
  })
})

describe('schema table request sharing and failure fences', () => {
  it('shares an in-flight table listing and then serves it from cache', async () => {
    const session = sessionId()
    const db = 'app_db'
    const gate = deferred()
    let requests = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/${db}/tables`, async () => {
        requests += 1
        await gate.promise
        return HttpResponse.json(mockTables)
      }),
    )

    const first = useSchemaStore.getState().loadTables(session, db)
    const second = useSchemaStore.getState().loadTables(session, db)
    await vi.waitFor(() => expect(requests).toBe(1))
    expect(useSchemaStore.getState().loadingTables.has(`${session}/${db}`)).toBe(true)

    gate.release()
    await expect(first).resolves.toEqual(mockTables)
    await expect(second).resolves.toEqual(mockTables)
    await useSchemaStore.getState().loadTables(session, db)

    expect(requests).toBe(1)
    expect(useSchemaStore.getState().loadingTables.has(`${session}/${db}`)).toBe(false)
  })

  it('resolves a failed table listing to an empty retryable result', async () => {
    const session = sessionId()
    const db = 'broken'
    let attempts = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/${db}/tables`, () => {
        attempts += 1
        return attempts === 1
          ? HttpResponse.json({ detail: 'tables failed' }, { status: 500 })
          : HttpResponse.json(mockTables)
      }),
    )

    await expect(useSchemaStore.getState().loadTables(session, db)).resolves.toEqual([])
    expect(useSchemaStore.getState().loadingTables.has(`${session}/${db}`)).toBe(false)
    await expect(useSchemaStore.getState().loadTables(session, db)).resolves.toEqual(mockTables)
  })

  it('drops a table failure that arrives after invalidation', async () => {
    const session = sessionId()
    const db = 'stale'
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/${db}/tables`, async () => {
        await gate.promise
        return HttpResponse.json({ detail: 'late tables failure' }, { status: 500 })
      }),
    )

    const request = useSchemaStore.getState().loadTables(session, db)
    useSchemaStore.getState().invalidateTablesForDb(session, db)
    gate.release()

    await expect(request).resolves.toEqual([])
    expect(useSchemaStore.getState().loadingTables.has(`${session}/${db}`)).toBe(false)
  })
})

describe('schema batch loading', () => {
  it('returns without a request when every schema is cached', async () => {
    const session = sessionId()
    useSchemaStore.setState({
      tables: {
        [`${session}/app`]: mockTables,
        [`${session}/analytics`]: mockTables,
      },
    })

    await expect(
      useSchemaStore.getState().loadTablesBatch(session, ['app', 'analytics', 'app'])
    ).resolves.toBeUndefined()
  })

  it('deduplicates a pending batch and fills missing groups with empty lists', async () => {
    const session = sessionId()
    const gate = deferred()
    let requests = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/tables`, async ({ request }) => {
        requests += 1
        expect(new URL(request.url).searchParams.getAll('databases')).toEqual(['app', 'empty'])
        await gate.promise
        return HttpResponse.json({ app: mockTables })
      }),
    )

    const first = useSchemaStore.getState().loadTablesBatch(session, ['app', 'empty', 'app'])
    const second = useSchemaStore.getState().loadTablesBatch(session, ['app'])
    gate.release()
    await first
    await second

    expect(requests).toBe(1)
    expect(useSchemaStore.getState().tables[`${session}/app`]).toEqual(mockTables)
    expect(useSchemaStore.getState().tables[`${session}/empty`]).toEqual([])
    expect(useSchemaStore.getState().loadingTables.size).toBe(0)
  })

  it('keeps precedence and loading state per schema invalidated mid-batch', async () => {
    const session = sessionId()
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${session}/tables`, async () => {
        await gate.promise
        return HttpResponse.json({ app: mockTables, analytics: mockTables })
      }),
    )

    const batch = useSchemaStore.getState().loadTablesBatch(session, ['app', 'analytics'])
    useSchemaStore.getState().invalidateTablesForDb(session, 'app')
    gate.release()
    await batch

    expect(useSchemaStore.getState().tables[`${session}/app`]).toBeUndefined()
    expect(useSchemaStore.getState().tables[`${session}/analytics`]).toEqual(mockTables)
    expect(useSchemaStore.getState().loadingTables.size).toBe(0)
  })

  it('clears batch loading after a failure and allows the schemas to retry', async () => {
    const session = sessionId()
    let attempts = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/tables`, () => {
        attempts += 1
        return attempts === 1
          ? HttpResponse.json({ detail: 'batch failed' }, { status: 500 })
          : HttpResponse.json({ app: mockTables })
      }),
    )

    await expect(
      useSchemaStore.getState().loadTablesBatch(session, ['app'])
    ).rejects.toThrow('batch failed')
    expect(useSchemaStore.getState().loadingTables.has(`${session}/app`)).toBe(false)

    await useSchemaStore.getState().loadTablesBatch(session, ['app'])
    expect(useSchemaStore.getState().tables[`${session}/app`]).toEqual(mockTables)
  })
})

describe('schema column and row-key requests', () => {
  it('shares in-flight column and row-key requests and caches their results', async () => {
    const session = sessionId()
    const gate = deferred()
    let columnRequests = 0
    let rowKeyRequests = 0
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/columns`, async () => {
        columnRequests += 1
        await gate.promise
        return HttpResponse.json(mockColumns)
      }),
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/row-key`, async () => {
        rowKeyRequests += 1
        await gate.promise
        return HttpResponse.json({ columns: ['id'], kind: 'primary' })
      }),
    )

    const columns = useSchemaStore.getState().loadColumns(session, 'app', 'users')
    const columnsAgain = useSchemaStore.getState().loadColumns(session, 'app', 'users')
    const rowKey = useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    const rowKeyAgain = useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    await vi.waitFor(() => {
      expect(columnRequests).toBe(1)
      expect(rowKeyRequests).toBe(1)
    })

    gate.release()
    await expect(columns).resolves.toEqual(mockColumns)
    await expect(columnsAgain).resolves.toEqual(mockColumns)
    await expect(rowKey).resolves.toEqual({ columns: ['id'], kind: 'primary' })
    await expect(rowKeyAgain).resolves.toEqual({ columns: ['id'], kind: 'primary' })

    await useSchemaStore.getState().loadColumns(session, 'app', 'users')
    await useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    expect(columnRequests).toBe(1)
    expect(rowKeyRequests).toBe(1)
  })

  it('returns safe defaults for failed column and row-key metadata', async () => {
    const session = sessionId()
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/columns`, () =>
        HttpResponse.json({ detail: 'columns failed' }, { status: 500 })
      ),
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/row-key`, () =>
        HttpResponse.json({ detail: 'row key failed' }, { status: 500 })
      ),
    )

    await expect(
      useSchemaStore.getState().loadColumns(session, 'app', 'users')
    ).resolves.toEqual([])
    await expect(
      useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    ).resolves.toEqual({ columns: [], kind: null })
  })

  it('drops column and row-key writes that arrive after invalidation', async () => {
    const session = sessionId()
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/columns`, async () => {
        await gate.promise
        return HttpResponse.json(mockColumns)
      }),
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/row-key`, async () => {
        await gate.promise
        return HttpResponse.json({ columns: ['id'], kind: 'primary' })
      }),
    )

    const columns = useSchemaStore.getState().loadColumns(session, 'app', 'users')
    const rowKey = useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    useSchemaStore.getState().invalidateTable(session, 'app', 'users')
    gate.release()

    await expect(columns).resolves.toEqual(mockColumns)
    await expect(rowKey).resolves.toEqual({ columns: ['id'], kind: 'primary' })
    expect(useSchemaStore.getState().columns[`${session}/app/users`]).toBeUndefined()
    expect(useSchemaStore.getState().rowKeys[`${session}/app/users`]).toBeUndefined()
  })
})

describe('schema invalidation ownership', () => {
  it('forgets every in-flight key owned by a session and clears their loading flags', async () => {
    const session = sessionId()
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${session}/databases`, async () => {
        await gate.promise
        return HttpResponse.json(mockDatabases)
      }),
      http.get(`${BASE}/sessions/${session}/databases/app/tables`, async () => {
        await gate.promise
        return HttpResponse.json(mockTables)
      }),
      http.get(`${BASE}/sessions/${session}/tables`, async () => {
        await gate.promise
        return HttpResponse.json({ app: mockTables })
      }),
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/columns`, async () => {
        await gate.promise
        return HttpResponse.json(mockColumns)
      }),
      http.get(`${BASE}/sessions/${session}/databases/app/tables/users/row-key`, async () => {
        await gate.promise
        return HttpResponse.json({ columns: ['id'], kind: 'primary' })
      }),
    )

    const databases = useSchemaStore.getState().loadDatabases(session)
    const tables = useSchemaStore.getState().loadTables(session, 'app')
    const batch = useSchemaStore.getState().loadTablesBatch(session, ['app'])
    const columns = useSchemaStore.getState().loadColumns(session, 'app', 'users')
    const rowKey = useSchemaStore.getState().loadRowKey(session, 'app', 'users')
    useSchemaStore.getState().invalidateSession(session)

    expect(useSchemaStore.getState().loadingDbs.size).toBe(0)
    expect(useSchemaStore.getState().loadingTables.size).toBe(0)

    gate.release()
    await Promise.all([databases, tables, batch, columns, rowKey])

    const state = useSchemaStore.getState()
    expect(state.databases[session]).toBeUndefined()
    expect(state.tables[`${session}/app`]).toBeUndefined()
    expect(state.columns[`${session}/app/users`]).toBeUndefined()
    expect(state.rowKeys[`${session}/app/users`]).toBeUndefined()
  })

  it('does not forget in-flight keys owned by another session', async () => {
    const other = sessionId()
    const target = sessionId()
    const gate = deferred()
    server.use(
      http.get(`${BASE}/sessions/${other}/databases/app/tables`, async () => {
        await gate.promise
        return HttpResponse.json(mockTables)
      }),
      http.get(`${BASE}/sessions/${other}/tables`, async () => {
        await gate.promise
        return HttpResponse.json({ app: mockTables })
      }),
      http.get(`${BASE}/sessions/${other}/databases/app/tables/users/columns`, async () => {
        await gate.promise
        return HttpResponse.json(mockColumns)
      }),
    )

    const tables = useSchemaStore.getState().loadTables(other, 'app')
    const batch = useSchemaStore.getState().loadTablesBatch(other, ['app'])
    const columns = useSchemaStore.getState().loadColumns(other, 'app', 'users')
    useSchemaStore.getState().invalidateSession(target)
    gate.release()

    await Promise.all([tables, batch, columns])
    expect(useSchemaStore.getState().tables[`${other}/app`]).toEqual(mockTables)
    expect(useSchemaStore.getState().columns[`${other}/app/users`]).toEqual(mockColumns)
  })
})
