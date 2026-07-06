import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  AUTH_REDIRECT_EVENT,
  AUTH_LOGOUT_EVENT,
} from '../../utils/authRedirect'
import AuthRedirectOverlay from '../../components/ui/AuthRedirectOverlay'

describe('AuthRedirectOverlay', () => {
  it('renders nothing initially', () => {
    const { container } = render(<AuthRedirectOverlay />)
    expect(container.innerHTML).toBe('')
  })

  it('renders session expired overlay on auth-redirect event', () => {
    render(<AuthRedirectOverlay />)

    act(() => { window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT)) })

    expect(screen.getByText('Session expired')).toBeInTheDocument()
    expect(screen.getByText('Your session has ended. Redirecting to sign in...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in now' })).toBeInTheDocument()
  })

  it('renders signing out overlay on auth-logout event', () => {
    render(<AuthRedirectOverlay />)

    act(() => { window.dispatchEvent(new Event(AUTH_LOGOUT_EVENT)) })

    expect(screen.getByText('Signing out')).toBeInTheDocument()
    expect(screen.getByText('Ending your session...')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls redirectToLdapLoginNow when Sign in now is clicked', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign, pathname: '/', search: '', hash: '' },
      writable: true,
    })

    render(<AuthRedirectOverlay />)
    act(() => { window.dispatchEvent(new Event(AUTH_REDIRECT_EVENT)) })

    act(() => {
      screen.getByRole('button', { name: 'Sign in now' }).click()
    })

    expect(assign).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith('/_auth/login?redirect=%2F')
  })
})
