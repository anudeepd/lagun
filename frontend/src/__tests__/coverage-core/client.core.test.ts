import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  apiFetch,
  errorMessageFromBody,
  requestResult,
} from '../../api/client'

type FetchCall = {
  url: string
  method: string
  body: BodyInit | null | undefined
  headers: HeadersInit | undefined
  signal: AbortSignal | null | undefined
}

const BASE = '/api/v1'

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function installFetch(respond?: (call: FetchCall) => Response | Promise<Response> | undefined) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: init?.headers,
      signal: init?.signal,
    }
    calls.push(call)
    const custom = await respond?.(call)
    if (custom) return custom
    if (call.method === 'DELETE' && /\/sessions\/[^/]+$/.test(call.url)) {
      return new Response(null, { status: 204 })
    }
    if (call.url.endsWith('/config/export')) {
      return new Response(new Blob(['archive']), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="lagun-backup.json"' },
      })
    }
    if (call.url.endsWith('/export') && call.method === 'POST') {
      return new Response('id,name\n1,Alice', { status: 200 })
    }
    if (call.url.endsWith('/sessions') && call.method === 'GET') return json([])
    if (/\/databases$/.test(call.url)) return json([])
    if (/\/tables(\?|$)/.test(call.url)) return json([])
    if (/\/columns$/.test(call.url)) return json([])
    if (/\/row-key$/.test(call.url)) return json({ columns: [], kind: null })
    if (/\/indexes$/.test(call.url)) return json([])
    if (/\/functions$/.test(call.url)) return json([])
    if (/\/create_sql$/.test(call.url)) return json({ create_sql: '' })
    return json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function expectCall(
  calls: FetchCall[],
  index: number,
  method: string,
  path: string,
) {
  expect(calls[index]).toMatchObject({ method, url: `${BASE}${path}` })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('API error formatting', () => {
  it('uses string details directly', () => {
    expect(errorMessageFromBody(400, 'Bad Request', JSON.stringify({ detail: 'invalid host' })))
      .toBe('invalid host')
  })

  it('flattens validation arrays while preserving field names', () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'host', 'port'], msg: 'must be a number' },
        { loc: ['body', 'name'], msg: 'required' },
        { loc: 'body', msg: 'loc must be an array' },
        { loc: [], msg: 42 },
        { loc: ['body'], nope: true },
        'plain issue',
        null,
      ],
    })

    expect(errorMessageFromBody(422, 'Unprocessable Entity', body)).toBe([
      'host.port: must be a number',
      'name: required',
      'loc must be an array',
      '{"loc":[],"msg":42}',
      '{"loc":["body"],"nope":true}',
      'plain issue',
      'null',
    ].join('\n'))
  })

  it('serializes structured details that are not validation arrays', () => {
    const detail = { error: 'bad', reason: 'lost' }
    expect(errorMessageFromBody(409, 'Conflict', JSON.stringify({ detail })))
      .toBe(JSON.stringify(detail))
  })

  it('uses a non-empty plain body and trims it before displaying', () => {
    expect(errorMessageFromBody(400, 'Bad Request', '  host refused connection  '))
      .toBe('  host refused connection  ')
  })

  it('falls back to the status when a plain body is only whitespace', () => {
    expect(errorMessageFromBody(400, 'Bad Request', '   ')).toBe('HTTP 400')
  })

  it('uses the empty status detail when both response text and status text are blank', () => {
    expect(errorMessageFromBody(400, '', '')).toBe('')
  })

  it('uses the status text when the body is empty', () => {
    expect(errorMessageFromBody(404, 'Not Found', '')).toBe('Not Found')
  })

  it('hides HTML proxy pages even below 500', () => {
    expect(errorMessageFromBody(403, 'Forbidden', '<!doctype html><title>no</title>'))
      .toBe('HTTP 403 Forbidden')
  })

  it('uses the bare status when a 5xx has no status text', () => {
    expect(errorMessageFromBody(502, '', 'upstream failed')).toBe('HTTP 502')
  })

  it('parses a JSON string payload through the plain-string branch', () => {
    expect(errorMessageFromBody(400, 'Bad Request', JSON.stringify('specific reason')))
      .toBe('specific reason')
  })
})

describe('fetch wrapper and request results', () => {
  it('returns successful responses and redirects only 401 responses', async () => {
    const { fetchMock } = installFetch(call =>
      call.url === '/ok' ? json({ ok: true }) : new Response('no', { status: 401 })
    )

    await expect(apiFetch('/ok')).resolves.toBeInstanceOf(Response)
    const event = vi.fn()
    window.addEventListener('lagun:auth-redirect', event)
    await expect(apiFetch('/private')).rejects.toThrow(
      'Authentication required. Redirecting to login.',
    )
    expect(event).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns structured failures for HTTP 200 database errors', async () => {
    installFetch(() => json({ ok: false, error: 'duplicate key' }))

    const result = await requestResult<{ ok: boolean; error?: string }>('/write', {
      method: 'POST',
    })

    expect(result).toEqual({
      ok: false,
      error: 'duplicate key',
      data: { ok: false, error: 'duplicate key' },
    })
  })

  it('turns transport and non-Error failures into structured results', async () => {
    const { fetchMock } = installFetch()
    fetchMock.mockRejectedValueOnce(new Error('socket closed'))
    await expect(requestResult('/first')).resolves.toEqual({
      ok: false,
      error: 'socket closed',
    })

    fetchMock.mockRejectedValueOnce('plain outage')
    await expect(requestResult('/second')).resolves.toEqual({
      ok: false,
      error: 'plain outage',
    })
  })

  it('surfaces response bodies as request errors and accepts 204 bodies', async () => {
    installFetch(call => call.url.endsWith('/broken')
      ? json({ detail: 'cannot connect' }, 503, { 'Content-Type': 'text/plain' })
      : undefined)

    await expect(api.getSessions()).resolves.toEqual([])
    await expect(api.deleteSession('session-1')).resolves.toBeUndefined()
  })

  it('throws the server detail for a failed request', async () => {
    installFetch(() => json({ detail: 'session missing' }, 404))

    await expect(api.getSession('missing')).rejects.toThrow('session missing')
  })
})

describe('client deadlines', () => {
  it('combines a caller cancellation signal with the request deadline', async () => {
    const { calls } = installFetch()
    const caller = new AbortController()

    await api.executeQuery('session-1', 'SELECT 1', undefined, 10, caller.signal)

    expect(calls[0].signal).not.toBe(caller.signal)
    expect(calls[0].signal?.aborted).toBe(false)
    caller.abort()
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('uses the caller signal when AbortSignal.any is unavailable', async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
    const { calls } = installFetch()
    const caller = new AbortController()

    try {
      await api.executeQuery('session-1', 'SELECT 1', undefined, 10, caller.signal)
      expect(calls[0].signal).toBe(caller.signal)
    } finally {
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor)
      else delete (AbortSignal as unknown as { any?: unknown }).any
    }
  })

  it('uses only the deadline when the caller supplies no signal', async () => {
    const { calls } = installFetch()

    await api.executeQuery('session-1', 'SELECT 1')

    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves operator-bounded scripts without a client deadline', async () => {
    const any = vi.spyOn(AbortSignal, 'any')
    const { calls } = installFetch()
    const caller = new AbortController()

    await api.executeScriptQuery(
      'session-1',
      { execution_id: 'e-1', sql: 'DELETE FROM t' },
      caller.signal,
    )

    expect(calls[0].signal).toBe(caller.signal)
    expect(any).not.toHaveBeenCalled()
  })
})

describe('session and schema client endpoints', () => {
  it('serializes every session request and schema lookup', async () => {
    const { calls } = installFetch()
    const session = {
      name: 'local',
      host: 'db',
      port: 3306,
      username: 'root',
      password: 'secret',
      query_limit: 100,
      ssl_enabled: false,
    }

    await api.getSessions()
    await api.createSession(session)
    await api.getSession('session-1')
    await api.updateSession('session-1', { name: 'renamed' })
    await api.deleteSession('session-1')
    await api.testSession('session-1')
    await api.probeConnection(session)
    await api.getDatabases('session-1')
    await api.getTables('session-1', 'app')
    await api.getTablesBatch('session-1', ['app', 'analytics'])
    await api.getColumns('session-1', 'app', 'users')
    await api.getRowKey('session-1', 'app', 'users')
    await api.getIndexes('session-1', 'app', 'users')
    await api.getFunctions('session-1', 'app')
    await api.getCreateSql('session-1', 'app', 'users')
    await api.analyzeTable('session-1', 'app', 'users')
    await api.analyzeTable('session-1', 'app', 'users', true)

    expectCall(calls, 0, 'GET', '/sessions')
    expectCall(calls, 1, 'POST', '/sessions')
    expect(JSON.parse(calls[1].body as string)).toEqual(session)
    expectCall(calls, 2, 'GET', '/sessions/session-1')
    expectCall(calls, 3, 'PUT', '/sessions/session-1')
    expect(JSON.parse(calls[3].body as string)).toEqual({ name: 'renamed' })
    expectCall(calls, 4, 'DELETE', '/sessions/session-1')
    expectCall(calls, 5, 'POST', '/sessions/session-1/test')
    expectCall(calls, 6, 'POST', '/sessions/probe')
    expectCall(calls, 7, 'GET', '/sessions/session-1/databases')
    expectCall(calls, 8, 'GET', '/sessions/session-1/databases/app/tables')
    expectCall(calls, 9, 'GET', '/sessions/session-1/tables?databases=app&databases=analytics')
    expectCall(calls, 10, 'GET', '/sessions/session-1/databases/app/tables/users/columns')
    expectCall(calls, 11, 'GET', '/sessions/session-1/databases/app/tables/users/row-key')
    expectCall(calls, 12, 'GET', '/sessions/session-1/databases/app/tables/users/indexes')
    expectCall(calls, 13, 'GET', '/sessions/session-1/databases/app/functions')
    expectCall(calls, 14, 'GET', '/sessions/session-1/databases/app/tables/users/create_sql')
    expectCall(calls, 15, 'POST', '/sessions/session-1/databases/app/tables/users/analyze?force=false')
    expectCall(calls, 16, 'POST', '/sessions/session-1/databases/app/tables/users/analyze?force=true')
  })
})

describe('query and mutation client endpoints', () => {
  it('serializes query, script, row, table, and column operations', async () => {
    const { calls } = installFetch()
    const signal = new AbortController().signal

    await api.executeQuery('s', 'SELECT 1', 'app', 50, signal, 'exec-1', 'tab-1')
    await api.killQuery('s')
    await api.killQueryExecution('s', 'a/b')
    await api.validateScriptQuery('s', { execution_id: 'e1', sql: 'INSERT INTO t VALUES (1)' })
    await api.validateScriptQuery('s', {
      execution_id: 'e2',
      sql: 'BEGIN',
      mode: 'transaction',
      database: 'app',
      tab_id: 'tab',
    })
    await api.executeScriptQuery('s', { execution_id: 'e3', sql: 'DELETE FROM t' })
    await api.executeSequentialScriptQuery('s', {
      execution_id: 'e4',
      sql: 'SELECT 1; SELECT 2',
      database: 'app',
      limit: 20,
      tab_id: 'tab',
    })
    await api.killScriptQuery('s', 'x/y')
    await api.cellUpdate('s', {
      database: 'app',
      table: 'users',
      primary_key: { id: 1 },
      column: 'name',
      new_value: 'Ada',
    })
    await api.rowUpdate('s', {
      database: 'app',
      table: 'users',
      primary_key: { id: 1 },
      updates: { name: 'Ada' },
    })
    await api.rowInsert('s', {
      database: 'app',
      table: 'users',
      values: { name: 'Ada' },
    })
    await api.rowDelete('s', {
      database: 'app',
      table: 'users',
      primary_keys: [{ id: 1 }, { id: 2 }],
    })
    await api.createTable('s', 'app', {
      name: 'events',
      columns: [{ name: 'id', type: 'int', nullable: false, primary_key: true, auto_increment: true }],
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    await api.dropTable('s', 'app', 'events')
    await api.truncateTable('s', 'app', 'events')
    await api.createIndex('s', 'app', 'events', {
      name: 'idx_created',
      columns: ['created_at'],
      unique: false,
      index_type: 'BTREE',
    })
    await api.dropIndex('s', 'app', 'events', 'idx_created')
    await api.setPrimaryKey('s', 'app', 'events', ['id'])
    await api.dropPrimaryKey('s', 'app', 'events')
    await api.addColumn('s', 'app', 'events', { name: 'note', type: 'text' })
    await api.modifyColumn('s', 'app', 'events', 'note', { type: 'varchar(255)' })
    await api.dropColumn('s', 'app', 'events', 'note')

    expectCall(calls, 0, 'POST', '/sessions/s/query')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      sql: 'SELECT 1',
      database: 'app',
      limit: 50,
      execution_id: 'exec-1',
      tab_id: 'tab-1',
    })
    expect(calls[0].headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    expectCall(calls, 1, 'DELETE', '/sessions/s/query')
    expectCall(calls, 2, 'DELETE', '/sessions/s/query/a%2Fb')
    expectCall(calls, 3, 'POST', '/sessions/s/query/script/validate')
    expect(JSON.parse(calls[3].body as string)).toEqual({
      execution_id: 'e1',
      sql: 'INSERT INTO t VALUES (1)',
      mode: 'transaction',
    })
    expectCall(calls, 4, 'POST', '/sessions/s/query/script/validate')
    expect(JSON.parse(calls[4].body as string)).toEqual({
      execution_id: 'e2',
      sql: 'BEGIN',
      mode: 'transaction',
      database: 'app',
      tab_id: 'tab',
    })
    expectCall(calls, 5, 'POST', '/sessions/s/query/script')
    expect(JSON.parse(calls[5].body as string)).toMatchObject({ mode: 'transaction' })
    expect(calls[5].signal).toBeUndefined()
    expectCall(calls, 6, 'POST', '/sessions/s/query/script/sequential')
    expectCall(calls, 7, 'DELETE', '/sessions/s/query/script/x%2Fy')
    expectCall(calls, 8, 'POST', '/sessions/s/cell-update')
    expectCall(calls, 9, 'POST', '/sessions/s/row-update')
    expectCall(calls, 10, 'POST', '/sessions/s/row-insert')
    expectCall(calls, 11, 'DELETE', '/sessions/s/rows')
    expectCall(calls, 12, 'POST', '/sessions/s/databases/app/tables')
    expectCall(calls, 13, 'DELETE', '/sessions/s/databases/app/tables/events')
    expectCall(calls, 14, 'POST', '/sessions/s/databases/app/tables/events/truncate')
    expectCall(calls, 15, 'POST', '/sessions/s/databases/app/tables/events/indexes')
    expectCall(calls, 16, 'DELETE', '/sessions/s/databases/app/tables/events/indexes/idx_created')
    expectCall(calls, 17, 'POST', '/sessions/s/databases/app/tables/events/primary-key')
    expect(JSON.parse(calls[17].body as string)).toEqual({ columns: ['id'] })
    expectCall(calls, 18, 'DELETE', '/sessions/s/databases/app/tables/events/primary-key')
    expectCall(calls, 19, 'POST', '/sessions/s/databases/app/tables/events/columns')
    expectCall(calls, 20, 'PUT', '/sessions/s/databases/app/tables/events/columns/note')
    expectCall(calls, 21, 'DELETE', '/sessions/s/databases/app/tables/events/columns/note')
    expect(JSON.parse(calls[20].body as string)).toEqual({ type: 'varchar(255)' })
  })
})

describe('export and import client endpoints', () => {
  it('downloads text and config archives through the API', async () => {
    const { calls } = installFetch()
    const createObjectURL = vi.fn(() => 'blob:backup')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(api.exportDownloadUrl('s')).toBe('/api/v1/sessions/s/export/download')
    await expect(api.exportText('s', { query: 'SELECT 1' })).resolves.toBe('id,name\n1,Alice')
    await api.exportConfig('secret phrase')

    expectCall(calls, 0, 'POST', '/sessions/s/export')
    expect(JSON.parse(calls[0].body as string)).toEqual({ query: 'SELECT 1' })
    expectCall(calls, 1, 'POST', '/config/export')
    expect(JSON.parse(calls[1].body as string)).toEqual({ passphrase: 'secret phrase' })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup')
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('lagun-backup.json')
    expect(anchor.href).toContain('blob:backup')
  })

  it('uses the default config filename when no download header is present', async () => {
    const { calls } = installFetch(call => call.url.endsWith('/config/export')
      ? new Response(new Blob(['archive']), { status: 200 })
      : undefined)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:backup'),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await api.exportConfig('secret')

    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(calls).toHaveLength(1)
    expect(anchor.download).toBe('lagun_sessions.json')
  })

  it('sends previews and config imports as multipart data', async () => {
    const { calls } = installFetch()
    const preview = new FormData()
    preview.append('file', new Blob(['x']), 'rows.csv')
    const file = new File(['config'], 'lagun.json', { type: 'application/json' })

    await api.importPreview('s', preview)
    await api.importConfig(file, 'pass phrase')

    expectCall(calls, 0, 'POST', '/sessions/s/import/preview')
    expect(calls[0].body).toBe(preview)
    expectCall(calls, 1, 'POST', '/config/import')
    const form = calls[1].body as FormData
    expect(form.get('passphrase')).toBe('pass phrase')
    expect((form.get('file') as File).name).toBe('lagun.json')
  })

  it('reports export, preview, and config-import server errors', async () => {
    installFetch(() => json({ detail: 'operation rejected' }, 500))
    const form = new FormData()
    const file = new File(['x'], 'lagun.json')

    await expect(api.exportText('s', {})).rejects.toThrow('operation rejected')
    await expect(api.importPreview('s', form)).rejects.toThrow('operation rejected')
    await expect(api.exportConfig('pass')).rejects.toThrow('operation rejected')
    await expect(api.importConfig(file, 'pass')).rejects.toThrow('operation rejected')
  })
})

describe('admin and presence client endpoints', () => {
  it('serializes every admin filter and page cursor', async () => {
    const { calls } = installFetch()

    await api.getServerConfig()
    await api.getAdminOverview()
    await api.getAdminConnections()
    await api.getAdminConnections('cursor/1')
    await api.getAdminUsers()
    await api.addAdminUser('alice')
    await api.addAdminUser('bob', 'fingerprint-b')
    await api.removeAdminUser('alice')
    await api.removeAdminUser('bob', 'fingerprint-b')
    await api.getAdminQueries()
    await api.getAdminPresence()
    await api.getAdminActivity()
    await api.getAdminActivity({}, 0)
    await api.getAdminActivity({
      username: '  alice  ',
      path: ' /admin/users ',
      search: ' login ',
      since: '2026-01-01',
      statusCode: 403,
    }, 17)
    await api.getAdminRetention()
    await api.getAdminRetention(90)
    await api.purgeAdminRetention(45)
    await api.reportPresence({
      client_id: 'client-1',
      active_tab_id: 'tab-1',
      tabs: [],
    })
    await api.deletePresence('client/1')

    expectCall(calls, 0, 'GET', '/config/server')
    expectCall(calls, 1, 'GET', '/admin/overview')
    expectCall(calls, 2, 'GET', '/admin/connections')
    expectCall(calls, 3, 'GET', '/admin/connections?after=cursor%2F1')
    expectCall(calls, 4, 'GET', '/admin/users')
    expectCall(calls, 5, 'POST', '/admin/users')
    expect(JSON.parse(calls[5].body as string)).toEqual({
      username: 'alice',
      expected_fingerprint: undefined,
    })
    expectCall(calls, 6, 'POST', '/admin/users')
    expect(JSON.parse(calls[6].body as string)).toEqual({
      username: 'bob',
      expected_fingerprint: 'fingerprint-b',
    })
    expectCall(calls, 7, 'DELETE', '/admin/users/alice')
    expect(JSON.parse(calls[7].body as string)).toEqual({ expected_fingerprint: undefined })
    expectCall(calls, 8, 'DELETE', '/admin/users/bob')
    expect(JSON.parse(calls[8].body as string)).toEqual({ expected_fingerprint: 'fingerprint-b' })
    expectCall(calls, 9, 'GET', '/admin/queries')
    expectCall(calls, 10, 'GET', '/admin/presence')
    expectCall(calls, 11, 'GET', '/admin/activity?limit=100')
    expectCall(calls, 12, 'GET', '/admin/activity?limit=100&before_id=0')
    expectCall(calls, 13, 'GET', '/admin/activity?limit=100&before_id=17&username=alice&path=%2Fadmin%2Fusers&search=login&since=2026-01-01&status_code=403')
    expectCall(calls, 14, 'GET', '/admin/retention?older_than_days=30')
    expectCall(calls, 15, 'GET', '/admin/retention?older_than_days=90')
    expectCall(calls, 16, 'POST', '/admin/retention/purge')
    expect(JSON.parse(calls[16].body as string)).toEqual({
      older_than_days: 45,
      confirmation: 'PURGE',
    })
    expectCall(calls, 17, 'POST', '/presence')
    expect(JSON.parse(calls[17].body as string)).toEqual({
      client_id: 'client-1',
      active_tab_id: 'tab-1',
      tabs: [],
    })
    expectCall(calls, 18, 'DELETE', '/presence/client%2F1')
  })

  it('ignores whitespace-only activity filters', async () => {
    const { calls } = installFetch()

    await api.getAdminActivity({
      username: ' ',
      path: '\t',
      search: '\n',
    })

    expect(calls[0].url).toBe('/api/v1/admin/activity?limit=100')
  })
})
