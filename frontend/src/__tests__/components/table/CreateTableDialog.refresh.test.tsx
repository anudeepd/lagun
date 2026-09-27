import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import CreateTableDialog from '../../../components/table/CreateTableDialog'
import { server } from '../../server'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

const BASE = 'http://localhost/api/v1'

describe('CreateTableDialog — success refresh after close/cancel race', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls onCreated even when the request resolves after close/cancel, and keeps Cancel closing only the live dialog', async () => {
    const gate = deferred<unknown>()
    const bodies: unknown[] = []
    server.use(
      http.post(`${BASE}/sessions/:id/databases/:db/tables`, async ({ request }) => {
        bodies.push(await request.json())
        await gate.promise
        return HttpResponse.json({ ok: true, sql: 'CREATE TABLE `app_db`.`widgets`' })
      }),
    )
    const onCreated = vi.fn()
    const onClose = vi.fn()

    const { rerender } = render(
      <CreateTableDialog open onClose={onClose} sessionId="session-1" database="app_db" onCreated={onCreated} />,
    )
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: 'Create Table' }))
    await waitFor(() => expect(bodies).toHaveLength(1))

    // The user cancels while the create request is still in flight; the open
    // flip invalidates the pending request id.
    rerender(
      <CreateTableDialog open={false} onClose={onClose} sessionId="session-1" database="app_db" onCreated={onCreated} />,
    )

    gate.resolve({ ok: true })
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    // A stale success refreshes schema/cache but must not close a newer dialog.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the live dialog after a normal successful create', async () => {
    server.use(
      http.post(`${BASE}/sessions/:id/databases/:db/tables`, () =>
        HttpResponse.json({ ok: true, sql: 'CREATE TABLE `app_db`.`widgets`' }),
      ),
    )
    const onCreated = vi.fn()
    const onClose = vi.fn()
    render(
      <CreateTableDialog open onClose={onClose} sessionId="session-1" database="app_db" onCreated={onCreated} />,
    )
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: 'Create Table' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
