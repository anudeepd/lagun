import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ldapLoginUrl,
  redirectToLdapLogin,
  resetAuthRedirectForTests,
} from '../../utils/authRedirect'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('MODE', 'test')
  resetAuthRedirectForTests()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  resetAuthRedirectForTests()
})

describe('LDAP redirect safeguards', () => {
  it('uses the current window location by default', () => {
    window.history.replaceState({}, '', '/workspace?tab=2#results')

    expect(ldapLoginUrl()).toBe(
      '/_auth/login?redirect=%2Fworkspace%3Ftab%3D2%23results',
    )
  })

  it('cannot be reset outside a test build', () => {
    vi.stubEnv('MODE', 'production')
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    redirectToLdapLogin()
    resetAuthRedirectForTests()
    redirectToLdapLogin()

    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('resets the one-shot latch in a test build', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    redirectToLdapLogin()
    resetAuthRedirectForTests()
    redirectToLdapLogin()

    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
