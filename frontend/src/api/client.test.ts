import { afterEach, describe, expect, it, vi } from 'vitest'

describe('apiFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.doUnmock('../utils/authRedirect')
    vi.resetModules()
  })

  it('redirects to LDAPGate when an API request returns 401', async () => {
    const redirectToLdapLogin = vi.fn()
    vi.doMock('../utils/authRedirect', () => ({ redirectToLdapLogin }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    ))

    const { apiFetch } = await import('./client')

    await expect(apiFetch('/api/v1/sessions')).rejects.toThrow('Authentication required')
    expect(redirectToLdapLogin).toHaveBeenCalledOnce()
  })

  it('leaves non-auth failures for callers to handle', async () => {
    const redirectToLdapLogin = vi.fn()
    vi.doMock('../utils/authRedirect', () => ({ redirectToLdapLogin }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Server error', { status: 500, statusText: 'Internal Server Error' })
    ))

    const { apiFetch } = await import('./client')
    const res = await apiFetch('/api/v1/sessions')

    expect(res.status).toBe(500)
    expect(redirectToLdapLogin).not.toHaveBeenCalled()
  })

  it('sends request-specific query execution IDs and cancellation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        columns: [],
        rows: [],
        row_count: 0,
        exec_time_ms: 1,
        execution_id: 'search-1',
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    // Dynamic import is required because this suite resets the module cache to
    // test the client module's authentication redirect dependency.
    const { api } = await import('./client')
    await api.executeQuery(
      'session-1',
      'SELECT 1',
      undefined,
      1000,
      undefined,
      'search-1',
    )
    await api.killQueryExecution('session-1', 'search-1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/sessions/session-1/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sql: 'SELECT 1',
          database: undefined,
          limit: 1000,
          execution_id: 'search-1',
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/sessions/session-1/query/search-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
