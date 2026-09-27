import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { mockSession } from '../handlers'
import SessionForm from '../../components/sessions/SessionForm'

const BASE = 'http://localhost/api/v1'

describe('SessionForm reopen', () => {
  it('is usable again after a close that left a save in flight', async () => {
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    const create = { finished: false }
    server.use(
      http.post(`${BASE}/sessions`, async () => {
        await pending
        create.finished = true
        return HttpResponse.json({ ...mockSession, id: 'created' }, { status: 201 })
      }),
    )

    const onClose = vi.fn()
    const user = userEvent.setup()
    // The connection list keeps this dialog mounted across closes, so the
    // component state survives a reopen.
    const view = render(<SessionForm open onClose={onClose} />)

    await user.type(screen.getByLabelText('Connection Name'), 'Slow')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()

    onClose.mockClear()
    view.rerender(<SessionForm open={false} onClose={onClose} />)
    view.rerender(<SessionForm open onClose={onClose} />)

    // The abandoned request's in-flight state must not carry into the reopen.
    const createButton = screen.getByRole('button', { name: 'Create' })
    await waitFor(() => expect(createButton).toBeEnabled())

    release()
    // Let the abandoned request and its continuation settle before judging.
    await waitFor(() => expect(create.finished).toBe(true))
    await act(async () => {})
    // …and it must not close the dialog the user is now looking at.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})
