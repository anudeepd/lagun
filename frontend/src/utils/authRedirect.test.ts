import { describe, expect, it } from 'vitest'
import { ldapLoginUrl } from './authRedirect'

describe('ldapLoginUrl', () => {
  it('preserves the current app path as the LDAP redirect target', () => {
    expect(ldapLoginUrl({
      pathname: '/query',
      search: '?session=db1',
      hash: '#results',
    })).toBe('/_auth/login?redirect=%2Fquery%3Fsession%3Ddb1%23results')
  })

  it('falls back to the app root when pathname is empty', () => {
    expect(ldapLoginUrl({
      pathname: '',
      search: '',
      hash: '',
    })).toBe('/_auth/login?redirect=%2F')
  })
})
