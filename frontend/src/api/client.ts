import { redirectToLdapLogin } from '../utils/authRedirect'
import type { AdminActivityFilters, AdminActivityResponse, AdminConnectionsResponse, AdminOverview, AdminRetention, AdminUsersResponse, PresenceUpdate, QueryResult, TableInfo } from '../types'

export const API_BASE = '/api/v1'

/**
 * Outcome of a request to an endpoint that reports a database failure as HTTP
 * 200 with `ok: false`. Returning a discriminated union makes ignoring the
 * failure a type error instead of a silent success.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

function formatApiError(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail
        .map(item => {
          if (!item || typeof item !== 'object') return String(item)
          const issue = item as { loc?: unknown[]; msg?: unknown }
          const field = Array.isArray(issue.loc) ? issue.loc.filter(x => x !== 'body').join('.') : ''
          const msg = typeof issue.msg === 'string' ? issue.msg : JSON.stringify(item)
          return field ? `${field}: ${msg}` : msg
        })
        .join('\n')
    }
    return JSON.stringify(detail)
  }
  if (typeof payload === 'string' && payload.trim()) return payload
  return `HTTP ${status}`
}

export async function apiFetch(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const res = await fetch(input, options)
  if (res.status === 401) {
    redirectToLdapLogin()
    throw new Error('Authentication required. Redirecting to login.')
  }
  return res
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  const text = await res.text()
  let payload: unknown = text || res.statusText
  try {
    payload = text ? JSON.parse(text) : { detail: res.statusText }
  } catch {
    // Keep the plain response body.
  }
  return formatApiError(res.status, payload)
}

/**
 * Bound a request that can otherwise hold a pooled database connection until the
 * server gives up. A caller-supplied signal (used for user cancellation) is kept
 * alongside the deadline.
 *
 * The deadline must stay ABOVE the server's own bound for the endpoint, or the
 * browser gives up on work the server is still doing and the user is told a
 * write failed when it is about to commit. The server bounds queries and row
 * writes at `LAGUN_QUERY_MAX_RUNTIME_SECONDS` (30s default) and bulk scripts at
 * `LAGUN_BULK_MAX_RUNTIME_SECONDS` (120s default); 120s covers the first with
 * room for DDL, and the bulk endpoints opt out entirely because their bound is
 * operator-tunable and the UI offers a cancel button.
 */
function withTimeout(options: RequestInit | undefined, timeoutMs?: number): RequestInit | undefined {
  if (!timeoutMs) return options
  const deadline = AbortSignal.timeout(timeoutMs)
  const callerSignal = options?.signal
  const signal =
    callerSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([callerSignal, deadline])
      : callerSignal ?? deadline
  return { ...options, signal }
}

async function request<T>(
  path: string,
  options?: RequestInit,
  /** Client deadline in ms; `null` leaves the request unbounded (the server still bounds it). */
  timeoutMs: number | null = 120_000,
): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> }
  if (options?.body) {
    headers['Content-Type'] ??= 'application/json'
  }
  const res = await apiFetch(`${API_BASE}${path}`, {
    ...withTimeout(options, options?.body && timeoutMs ? timeoutMs : undefined),
    headers,
  })
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res))
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

/**
 * Like `request`, but for the endpoints that answer HTTP 200 with `ok: false`
 * and an `error` string when the statement failed (row writes, kill, execute).
 * A transport error and a rejected statement both land in `{ ok: false }`.
 */
export async function requestResult<T extends { error?: string | null }>(
  path: string,
  options?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const data = await request<T>(path, options)
    if (data && typeof data === 'object' && data.error) {
      return { ok: false, error: String(data.error) }
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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
  getTables: (sessionId: string, db: string, signal?: AbortSignal) =>
    request<import('../types').TableInfo[]>(`/sessions/${sessionId}/databases/${db}/tables`, { signal }),
  getTablesBatch: (sessionId: string, databases: string[], signal?: AbortSignal) => {
    const params = new URLSearchParams()
    databases.forEach(db => params.append('databases', db))
    return request<Record<string, TableInfo[]>>(
      `/sessions/${sessionId}/tables?${params.toString()}`,
      { signal }
    )
  },
  getColumns: (sessionId: string, db: string, table: string, signal?: AbortSignal) =>
    request<import('../types').ColumnInfo[]>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns`,
      { signal }
    ),
  getIndexes: (sessionId: string, db: string, table: string, signal?: AbortSignal) =>
    request<import('../types').IndexInfo[]>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/indexes`,
      { signal }
    ),
  getFunctions: (sessionId: string, db: string) =>
    request<string[]>(`/sessions/${sessionId}/databases/${db}/functions`),
  getCreateSql: (sessionId: string, db: string, table: string) =>
    request<{ create_sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/create_sql`
    ),
  analyzeTable: (sessionId: string, db: string, table: string, force = false) =>
    request<{ ok: boolean; analyzed: boolean; row_count: number | null; data_length: number | null }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/analyze?force=${force}`,
      { method: 'POST' }
    ),

  // Query
  executeQuery: (
    sessionId: string,
    sql: string,
    database?: string,
    limit?: number,
    signal?: AbortSignal,
    executionId?: string,
    tabId?: string,
  ) =>
    request<QueryResult>(`/sessions/${sessionId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, database, limit, execution_id: executionId, tab_id: tabId }),
      signal,
    }),
  killQuery: (sessionId: string) =>
    requestResult<{ ok: boolean; error?: string }>(`/sessions/${sessionId}/query`, { method: 'DELETE' }),
  killQueryExecution: (sessionId: string, executionId: string) =>
    requestResult<{ ok: boolean; error?: string }>(
      `/sessions/${sessionId}/query/${encodeURIComponent(executionId)}`,
      { method: 'DELETE' },
    ),
  validateScriptQuery: (sessionId: string, payload: {
    execution_id: string; sql: string; database?: string; mode?: 'transaction'; tab_id?: string
  }, signal?: AbortSignal) =>
    request<import('../types').ScriptQueryValidationResult>(
      `/sessions/${sessionId}/query/script/validate`,
      {
        method: 'POST',
        body: JSON.stringify({ ...payload, mode: payload.mode ?? 'transaction' }),
        signal,
      },
      // A bulk script may run for LAGUN_BULK_MAX_RUNTIME_SECONDS (120s default,
      // operator-tunable), so no client deadline: the server's own limit and the
      // caller's cancel signal are the authority.
      null,
    ),
  executeScriptQuery: (sessionId: string, payload: {
    execution_id: string; sql: string; database?: string; mode?: 'transaction'; tab_id?: string
  }, signal?: AbortSignal) =>
    request<import('../types').ScriptQueryResult>(
      `/sessions/${sessionId}/query/script`,
      {
        method: 'POST',
        body: JSON.stringify({ ...payload, mode: payload.mode ?? 'transaction' }),
        signal,
      },
      null,
    ),
  killScriptQuery: (sessionId: string, executionId: string) =>
    requestResult<{ ok: boolean; error?: string }>(
      `/sessions/${sessionId}/query/script/${encodeURIComponent(executionId)}`,
      { method: 'DELETE' }
    ),
  cellUpdate: (sessionId: string, payload: {
    database: string; table: string; primary_key: Record<string, unknown>;
    column: string; new_value: unknown;
  }) =>
    requestResult<{ ok: boolean; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/cell-update`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowUpdate: (sessionId: string, payload: {
    database: string; table: string;
    primary_key: Record<string, unknown>;
    updates: Record<string, unknown>;
  }) =>
    requestResult<{ ok: boolean; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/row-update`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowInsert: (sessionId: string, payload: {
    database: string; table: string; values: Record<string, unknown>;
  }) =>
    requestResult<{ ok: boolean; insert_id?: number; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/row-insert`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  rowDelete: (sessionId: string, payload: {
    database: string; table: string; primary_keys: Record<string, unknown>[];
  }) =>
    requestResult<{ ok: boolean; affected_rows: number; sql_executed: string; error?: string }>(
      `/sessions/${sessionId}/rows`,
      { method: 'DELETE', body: JSON.stringify(payload) }
    ),

  // Table ops
  createTable: (sessionId: string, db: string, data: import('../types').CreateTableRequest) =>
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
  createIndex: (sessionId: string, db: string, table: string, data: import('../types').CreateIndexRequest) =>
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
    name: string; type: string; nullable?: boolean; default?: string | null; default_is_literal?: boolean; comment?: string
  }) =>
    request<{ ok: boolean; sql: string }>(
      `/sessions/${sessionId}/databases/${db}/tables/${table}/columns`,
      { method: 'POST', body: JSON.stringify(data) }
    ),
  modifyColumn: (sessionId: string, db: string, table: string, column: string, data: {
    type: string; name?: string; nullable?: boolean; default?: string | null; default_is_literal?: boolean; comment?: string
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

  // Export / import: multipart bodies and a native download, which the JSON
  // helper cannot express. Kept here so the API prefix and the error-body
  // parsing live in one place instead of being rebuilt at each call site.
  exportDownloadUrl: (sessionId: string) =>
    `${API_BASE}/sessions/${sessionId}/export/download`,

  exportText: async (sessionId: string, body: unknown): Promise<string> => {
    const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res))
    }
    return res.text()
  },

  importPreview: async <T>(sessionId: string, form: FormData): Promise<T> => {
    const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/import/preview`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res))
    }
    return res.json()
  },

  importFile: async <T>(sessionId: string, form: FormData): Promise<T> => {
    const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/import`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res))
    }
    return res.json()
  },

  // Config export/import
  exportConfig: async (passphrase: string): Promise<void> => {
    const res = await apiFetch(`${API_BASE}/config/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res))
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
    const res = await apiFetch(`${API_BASE}/config/import`, { method: 'POST', body: form })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res))
    }
    return res.json()
  },

  getServerConfig: () => request<{ ldap_enabled: boolean; ldap_idle_timeout: number; is_admin: boolean }>('/config/server'),
  getAdminOverview: () => request<AdminOverview>('/admin/overview'),
  getAdminConnections: () => request<AdminConnectionsResponse>('/admin/connections'),
  getAdminUsers: () => request<AdminUsersResponse>('/admin/users'),
  addAdminUser: (username: string, expectedFingerprint?: string) =>
    request<{ ok: boolean; username: string; fingerprint: string }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, expected_fingerprint: expectedFingerprint }),
    }),
  removeAdminUser: (username: string, expectedFingerprint?: string) =>
    request<{ ok: boolean; username: string; fingerprint: string; revoked_sessions: number }>(
      `/admin/users/${encodeURIComponent(username)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({ expected_fingerprint: expectedFingerprint }),
      },
    ),
  getAdminQueries: () => request<import('../types').AdminQueriesResponse>('/admin/queries'),
  getAdminPresence: () => request<import('../types').AdminPresenceResponse>('/admin/presence'),
  getAdminActivity: (filters: AdminActivityFilters = {}, beforeId?: number) => {
    const params = new URLSearchParams({ limit: '100' })
    if (beforeId !== undefined) params.set('before_id', String(beforeId))
    if (filters.username?.trim()) params.set('username', filters.username.trim())
    if (filters.path?.trim()) params.set('path', filters.path.trim())
    if (filters.search?.trim()) params.set('search', filters.search.trim())
    if (filters.since) params.set('since', filters.since)
    if (filters.statusCode) params.set('status_code', String(filters.statusCode))
    return request<AdminActivityResponse>(`/admin/activity?${params.toString()}`)
  },
  getAdminRetention: (olderThanDays = 30) =>
    request<AdminRetention>(`/admin/retention?older_than_days=${olderThanDays}`),
  purgeAdminRetention: (olderThanDays: number) =>
    request<{ deleted: number; older_than_days: number }>('/admin/retention/purge', {
      method: 'POST',
      body: JSON.stringify({ older_than_days: olderThanDays, confirmation: 'PURGE' }),
    }),
  reportPresence: (payload: PresenceUpdate) =>
    request<{ ok: boolean }>('/presence', { method: 'POST', body: JSON.stringify(payload) }),
  deletePresence: (clientId: string) =>
    request<{ ok: boolean }>(`/presence/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
}
