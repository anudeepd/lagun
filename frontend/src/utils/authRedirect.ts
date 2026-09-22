type AuthRedirectLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

export const AUTH_REDIRECT_EVENT = 'lagun:auth-redirect'
export const AUTH_LOGOUT_EVENT = 'lagun:auth-logout'
export const AUTH_REDIRECT_DELAY_MS = 1500

let redirectInProgress = false

function dispatchAuthEvent(type: string) {
  window.dispatchEvent(new Event(type))
}

export function ldapLoginUrl(location: AuthRedirectLocation = window.location): string {
  const redirectPath = `${location.pathname || '/'}${location.search}${location.hash}`
  return `/_auth/login?redirect=${encodeURIComponent(redirectPath)}`
}

export function redirectToLdapLoginNow(): void {
  window.location.assign(ldapLoginUrl())
}

export function redirectToLdapLogin(): void {
  if (redirectInProgress) return
  redirectInProgress = true
  dispatchAuthEvent(AUTH_REDIRECT_EVENT)
  window.setTimeout(redirectToLdapLoginNow, AUTH_REDIRECT_DELAY_MS)
}

export function submitLdapLogout(form: HTMLFormElement): void {
  dispatchAuthEvent(AUTH_LOGOUT_EVENT)
  window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS)
}

/**
 * Test-only latch reset. Guarded on the build mode so the shipped bundle can
 * never clear `redirectInProgress` (which would allow an auth-redirect storm);
 * Vite statically replaces `import.meta.env.MODE`, so the body is dropped from
 * production output entirely.
 */
export function resetAuthRedirectForTests(): void {
  if (import.meta.env.MODE !== 'test') return
  redirectInProgress = false
}
