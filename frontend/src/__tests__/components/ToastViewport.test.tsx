import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ToastViewport from '../../components/ui/ToastViewport'
import { showToast } from '../../utils/toast'

afterEach(cleanup)

describe('ToastViewport', () => {
  it('announces each toast through the toast itself, not a nested live region', () => {
    const { container } = render(<ToastViewport />)
    expect(container.firstElementChild).not.toHaveAttribute('aria-live')

    act(() => showToast('Could not load connections.', 'error'))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load connections.')

    act(() => showToast('Added bob to LDAP access policy.'))
    expect(screen.getByRole('status')).toHaveTextContent('Added bob to LDAP access policy.')
  })
})
