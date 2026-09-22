import { http, HttpResponse } from 'msw'

const BASE = 'http://localhost/api/v1'

export const mockSession = {
  id: 'session-1',
  name: 'Test DB',
  host: 'localhost',
  port: 3306,
  username: 'root',
  default_db: null,
  query_limit: 100,
  ssl_enabled: false,
  selected_databases: [],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

export const mockDatabases = ['app_db', 'analytics']

export const mockTables = [
  {
    name: 'users',
    table_type: 'BASE TABLE',
    engine: 'InnoDB',
    row_count: 2,
    data_length: 16384,
    comment: '',
  },
]

export const mockColumns = [
  {
    name: 'id',
    data_type: 'int',
    column_type: 'int',
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    is_auto_increment: true,
    extra: 'auto_increment',
    comment: '',
  },
  {
    name: 'name',
    data_type: 'varchar',
    column_type: 'varchar(100)',
    is_nullable: false,
    column_default: null,
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: '',
  },
]

// ── Table data: SELECT + row mutation endpoints ─────────────────────────
//
// The data tab applies an edit locally and then reloads, so a fixed fixture
// would erase the very change a test just made. These handlers therefore read
// and write one mutable in-memory table, and record the parsed request body of
// every data-path call so a test can assert what the component serialized.

/** Column names the mock data endpoints speak — mirrors `mockColumns`. */
export const mockDataColumns = ['id', 'name']

const INITIAL_TABLE_ROWS: unknown[][] = [
  [1, 'Alice'],
  [2, 'Bob'],
]

/** Rows `POST /query` returns; the row-write handlers mutate them in place. */
export const mockTableRows: unknown[][] = INITIAL_TABLE_ROWS.map(row => [...row])

export function resetMockTableRows() {
  mockTableRows.length = 0
  mockTableRows.push(...INITIAL_TABLE_ROWS.map(row => [...row]))
}

export interface CapturedDataRequest {
  method: string
  url: string
  body: Record<string, unknown> | null
}

/** Data-path requests the component sent, in arrival order. */
export const dataRequests: Record<
  'query' | 'cellUpdate' | 'rowUpdate' | 'rowInsert' | 'rowDelete',
  CapturedDataRequest[]
> = {
  query: [],
  cellUpdate: [],
  rowUpdate: [],
  rowInsert: [],
  rowDelete: [],
}

export function resetDataRequests() {
  for (const captured of Object.values(dataRequests)) captured.length = 0
}

async function captureDataRequest(
  kind: keyof typeof dataRequests,
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  dataRequests[kind].push({ method: request.method, url: new URL(request.url).pathname, body })
  return body ?? {}
}

/** A MySQL literal for the `sql_executed` strings, shared so every handler
 *  renders values identically. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  return typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`
}

function whereSql(primaryKey: Record<string, unknown>): string {
  return Object.entries(primaryKey)
    .map(([name, value]) => `\`${name}\`=${sqlLiteral(value)}`)
    .join(' AND ')
}

function rowMatchesKey(row: unknown[], primaryKey: Record<string, unknown>): boolean {
  return Object.entries(primaryKey).every(([name, value]) => {
    const index = mockDataColumns.indexOf(name)
    return index !== -1 && String(row[index]) === String(value)
  })
}

export const handlers = [
  http.get(`${BASE}/config/server`, () =>
    HttpResponse.json({ ldap_enabled: false, ldap_idle_timeout: 0, is_admin: false })
  ),

  // Sessions
  http.get(`${BASE}/sessions`, () => HttpResponse.json([mockSession])),
  http.post(`${BASE}/sessions`, () => HttpResponse.json(mockSession, { status: 201 })),
  http.get(`${BASE}/sessions/:id`, ({ params }) =>
    HttpResponse.json({ ...mockSession, id: params.id as string })
  ),
  http.put(`${BASE}/sessions/:id`, async ({ request, params }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({ ...mockSession, id: params.id as string, ...body })
  }),
  http.delete(`${BASE}/sessions/:id`, () => new HttpResponse(null, { status: 204 })),
  http.post(`${BASE}/sessions/:id/test`, () =>
    HttpResponse.json({ ok: true, server_version: '8.0.0', latency_ms: 5.2, databases: mockDatabases })
  ),
  http.post(`${BASE}/sessions/probe`, () =>
    HttpResponse.json({ ok: true, server_version: '8.0.0', latency_ms: 5.2, databases: mockDatabases })
  ),

  // Schema
  http.get(`${BASE}/sessions/:id/databases`, () => HttpResponse.json(mockDatabases)),
  http.get(`${BASE}/sessions/:id/tables`, ({ request }) => {
    const databases = new URL(request.url).searchParams.getAll('databases')
    return HttpResponse.json(
      Object.fromEntries(databases.map(db => [db, mockTables]))
    )
  }),
  http.get(`${BASE}/sessions/:id/databases/:db/tables`, () => HttpResponse.json(mockTables)),
  http.get(`${BASE}/sessions/:id/databases/:db/tables/:table/columns`, () =>
    HttpResponse.json(mockColumns)
  ),
  http.post(`${BASE}/sessions/:id/databases/:db/tables/:table/analyze`, () =>
    HttpResponse.json({ ok: true, analyzed: true, row_count: 2, data_length: 16384 })
  ),
  http.get(`${BASE}/sessions/:id/databases/:db/functions`, () => HttpResponse.json([])),

  // Table data: SELECT and the row-mutation endpoints the data tab writes through
  http.post(`${BASE}/sessions/:id/query`, async ({ request }) => {
    await captureDataRequest('query', request)
    return HttpResponse.json({
      columns: [...mockDataColumns],
      rows: mockTableRows.map(row => [...row]),
      row_count: mockTableRows.length,
      exec_time_ms: 4.2,
    })
  }),
  http.post(`${BASE}/sessions/:id/cell-update`, async ({ request }) => {
    const body = await captureDataRequest('cellUpdate', request)
    const primaryKey = (body.primary_key ?? {}) as Record<string, unknown>
    const columnIndex = mockDataColumns.indexOf(String(body.column ?? ''))
    let affected = 0
    for (const row of mockTableRows) {
      if (!rowMatchesKey(row, primaryKey)) continue
      if (columnIndex !== -1) row[columnIndex] = body.new_value
      affected += 1
    }
    return HttpResponse.json({
      ok: true,
      affected_rows: affected,
      sql_executed: `UPDATE \`${String(body.table ?? '')}\` SET \`${String(body.column ?? '')}\`=${sqlLiteral(body.new_value)} WHERE ${whereSql(primaryKey)}`,
    })
  }),
  http.post(`${BASE}/sessions/:id/row-update`, async ({ request }) => {
    const body = await captureDataRequest('rowUpdate', request)
    const primaryKey = (body.primary_key ?? {}) as Record<string, unknown>
    const updates = (body.updates ?? {}) as Record<string, unknown>
    const matched = mockTableRows.filter(row => rowMatchesKey(row, primaryKey))
    for (const row of matched) {
      for (const [name, value] of Object.entries(updates)) {
        const index = mockDataColumns.indexOf(name)
        if (index !== -1) row[index] = value
      }
    }
    const setSql = Object.entries(updates)
      .map(([name, value]) => `\`${name}\`=${sqlLiteral(value)}`)
      .join(', ')
    return HttpResponse.json({
      ok: true,
      affected_rows: matched.length,
      sql_executed: `UPDATE \`${String(body.table ?? '')}\` SET ${setSql} WHERE ${whereSql(primaryKey)}`,
    })
  }),
  http.post(`${BASE}/sessions/:id/row-insert`, async ({ request }) => {
    const body = await captureDataRequest('rowInsert', request)
    const values = (body.values ?? {}) as Record<string, unknown>
    const insertId = mockTableRows.reduce((max, row) => Math.max(max, Number(row[0]) || 0), 0) + 1
    const row = mockDataColumns.map((column, index) =>
      column in values ? values[column] : (index === 0 ? insertId : null)
    )
    mockTableRows.push(row)
    const columns = Object.keys(values)
    return HttpResponse.json({
      ok: true,
      insert_id: insertId,
      affected_rows: 1,
      sql_executed: `INSERT INTO \`${String(body.table ?? '')}\` (${columns.map(name => `\`${name}\``).join(', ')}) VALUES (${columns.map(name => sqlLiteral(values[name])).join(', ')})`,
    })
  }),
  http.delete(`${BASE}/sessions/:id/rows`, async ({ request }) => {
    const body = await captureDataRequest('rowDelete', request)
    const primaryKeys = Array.isArray(body.primary_keys)
      ? body.primary_keys as Record<string, unknown>[]
      : []
    let affected = 0
    for (const primaryKey of primaryKeys) {
      for (let index = mockTableRows.length - 1; index >= 0; index -= 1) {
        if (!rowMatchesKey(mockTableRows[index], primaryKey)) continue
        mockTableRows.splice(index, 1)
        affected += 1
      }
    }
    return HttpResponse.json({
      ok: true,
      affected_rows: affected,
      sql_executed: `DELETE FROM \`${String(body.table ?? '')}\` WHERE ${primaryKeys.map(pk => `(${whereSql(pk)})`).join(' OR ')}`,
    })
  }),

  // Script execution
  http.post(`${BASE}/sessions/:id/query/script/validate`, async ({ request }) => {
    const body = await request.json() as { sql?: string; execution_id?: string }
    const sql = body.sql ?? ''
    const stmtCount = sql.split(';').filter(s => s.trim()).length
    return HttpResponse.json({
      ok: true,
      statement_count: stmtCount,
      operation_counts: { INSERT: stmtCount },
    })
  }),
  http.post(`${BASE}/sessions/:id/query/script`, async ({ request }) => {
    const body = await request.json() as { execution_id?: string; sql?: string }
    const sql = body.sql ?? ''
    const stmtCount = sql.split(';').filter(s => s.trim()).length
    return HttpResponse.json({
      ok: true,
      execution_id: body.execution_id ?? 'test',
      statements_executed: stmtCount,
      affected_rows: stmtCount,
      exec_time_ms: 10.5,
      rolled_back: false,
    })
  }),
  http.delete(`${BASE}/sessions/:id/query/script/:execId`, () =>
    HttpResponse.json({ ok: true })
  ),
]
