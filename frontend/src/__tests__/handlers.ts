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

export const handlers = [
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
  http.get(`${BASE}/sessions/:id/databases/:db/tables`, () => HttpResponse.json(mockTables)),
  http.get(`${BASE}/sessions/:id/databases/:db/tables/:table/columns`, () =>
    HttpResponse.json(mockColumns)
  ),
]
