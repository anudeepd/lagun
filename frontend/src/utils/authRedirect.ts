type AuthRedirectLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

let redirectInProgress = false

export function ldapLoginUrl(location: AuthRedirectLocation = window.location): string {
  const redirectPath = `${location.pathname || '/'}${location.search}${location.hash}`
  return `/_auth/login?redirect=${encodeURIComponent(redirectPath)}`
}

export function redirectToLdapLogin(): void {
  if (redirectInProgress) return
  redirectInProgress = true
  window.location.assign(ldapLoginUrl())
}
