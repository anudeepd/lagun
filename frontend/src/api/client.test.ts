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
})
