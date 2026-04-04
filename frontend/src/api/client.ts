const BASE = '/api/v1'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> }
  if (options?.body) {
    headers['Content-Type'] ??= 'application/json'
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  // Sessions
  getSessions: () => request<import('../types').Session[]>('/sessions'),
  createSession: (data: import('../types').SessionCreate) =>
    request<import('../types').Session>('/sessions', {
      method: 'POST', body: JSON.stringify(data),
    }),
  getSession: (id: string) =>
    request<import('../types').Session>(`/sessions/${id}`),
  updateSession: (id: string, data: import('../types').SessionUpdate) =>
    request<import('../types').Session>(`/sessions/${id}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),
  deleteSession: (id: string) =>
    request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  testSession: (id: string) =>
    request<import('../types').TestResult>(`/sessions/${id}/test`, { method: 'POST' }),
  probeConnection: (data: import('../types').ProbeRequest) =>
    request<import('../types').TestResult>('/sessions/probe', {
      method: 'POST', body: JSON.stringify(data),
    }),

  // Schema
  getDatabases: (sessionId: string) =>
    request<string[]>(`/sessions/${sessionId}/databases`),
  getTables: (sessionId: string, db: string) =>
    request<import('../types').TableInfo[]>(`/sessions/${sessionId}/databases/${db}/tables`),
  getColumns: (sessionId: string, db: string, table: string, signal?: AbortSignal) =>
    request<import('../types').ColumnInfo[]>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns`,
      { signal }
    ),
  getIndexes: (sessionId: string, db: string, table: string) =>
    request<import('../types').IndexInfo[]>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/indexes`
    ),
  getFunctions: (sessionId: string, db: string) =>
    request<string[]>(`/sessions/${sessionId}/databases/${db}/functions`),
  getCreateSql: (sessionId: string, db: string, table: string) =>
    request<{ create_sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/create_sql`
    ),

  // Query
  executeQuery: (sessionId: string, sql: string, database?: string, limit?: number, signal?: AbortSignal) =>
    request<import('../types').QueryResult>(`/sessions/${sessionId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, database, limit }),
      signal,
    }),
  killQuery: (sessionId: string) =>
    request<{ ok: boolean; error?: string }>(`/sessions/${sessionId}/query`, { method: 'DELETE' }),
  cellUpdate: (sessionId: string, payload: {
    database: string; table: string; primary_key: Record<string, unknown>;
    column: string; new_value: unknown;
  }) =>
    request<{ ok: boolean; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/cell-update`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowUpdate: (sessionId: string, payload: {
    database: string; table: string;
    primary_key: Record<string, unknown>;
    updates: Record<string, unknown>;
  }) =>
    request<{ ok: boolean; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/row-update`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowInsert: (sessionId: string, payload: {
    database: string; table: string; values: Record<string, unknown>;
  }) =>
    request<{ ok: boolean; insert_id?: number; error?: string }>(
      `/sessions/${sessionId}/row-insert`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowDelete: (sessionId: string, payload: {
    database: string; table: string; primary_keys: Record<string, unknown>[];
  }) =>
    request<{ ok: boolean; affected_rows: number; error?: string }>(
      `/sessions/${sessionId}/rows`,
      { method: 'DELETE', body: JSON.stringify(payload) }
    ),

  // Table ops
  createTable: (sessionId: string, db: string, data: import('../types').TableInfo) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables`,
      { method: 'POST', body: JSON.stringify(data) }
    ),
  dropTable: (sessionId: string, db: string, table: string) =>
    request<{ ok: boolean }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}`,
      { method: 'DELETE' }
    ),
  truncateTable: (sessionId: string, db: string, table: string) =>
    request<{ ok: boolean }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/truncate`,
      { method: 'POST' }
    ),
  createIndex: (sessionId: string, db: string, table: string, data: import('../types').IndexInfo) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/indexes`,
      { method: 'POST', body: JSON.stringify(data) }
    ),
  dropIndex: (sessionId: string, db: string, table: string, indexName: string) =>
    request<{ ok: boolean }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/indexes/${indexName}`,
      { method: 'DELETE' }
    ),
  setPrimaryKey: (sessionId: string, db: string, table: string, columns: string[]) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/primary-key`,
      { method: 'POST', body: JSON.stringify({ columns }) }
    ),
  dropPrimaryKey: (sessionId: string, db: string, table: string) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/primary-key`,
      { method: 'DELETE' }
    ),

  // Column ops
  addColumn: (sessionId: string, db: string, table: string, data: {
    name: string; type: string; nullable?: boolean; default?: string | null; comment?: string
  }) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns`,
      { method: 'POST', body: JSON.stringify(data) }
    ),
  modifyColumn: (sessionId: string, db: string, table: string, column: string, data: {
    name?: string; type?: string; nullable?: boolean; default?: string | null; comment?: string
  }) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns/${column}`,
      { method: 'PUT', body: JSON.stringify(data) }
    ),
  dropColumn: (sessionId: string, db: string, table: string, column: string) =>
    request<{ ok: boolean }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns/${column}`,
      { method: 'DELETE' }
    ),

  // Config export/import
  exportConfig: async (passphrase: string): Promise<void> => {
    const res = await fetch(`${BASE}/config/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const match = disposition.match(/filename="([^"]+)"/)
    const filename = match ? match[1] : 'lagun_sessions.json'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },

  importConfig: async (file: File, passphrase: string): Promise<{ imported: number; skipped: number }> => {
    const form = new FormData()
    form.append('file', file)
    form.append('passphrase', passphrase)
    const res = await fetch(`${BASE}/config/import`, { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    return res.json()
  },

  getServerConfig: () => request<{ ldap_enabled: boolean }>('/config/server'),
}
