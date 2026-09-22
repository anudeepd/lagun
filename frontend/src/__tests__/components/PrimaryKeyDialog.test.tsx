import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import PrimaryKeyDialog from '../../components/table/PrimaryKeyDialog'
import { server } from '../server'

const BASE = 'http://localhost/api/v1'

const columns = ['id', 'tenant_id', 'email', 'status']

const isChecked = (name: string) =>
  screen.getByRole('button', { name }).className.includes('bg-brand-600')

const renderDialog = (currentPkColumns: string[]) => (
  <PrimaryKeyDialog
    open
    onClose={vi.fn()}
    sessionId="session-1"
    database="app_db"
    table="users"
    columns={columns}
    currentPkColumns={currentPkColumns}
  />
)

describe('PrimaryKeyDialog preselection', () => {
  it('checks the existing composite key when it opens', () => {
    render(renderDialog(['id', 'tenant_id']))

    expect(isChecked('id')).toBe(true)
    expect(isChecked('tenant_id')).toBe(true)
    expect(isChecked('email')).toBe(false)
    expect(isChecked('status')).toBe(false)
    expect(screen.getByRole('button', { name: 'Drop PK' })).toBeInTheDocument()
  })

  it('never offers "Drop PK" while nothing is checked', () => {
    render(renderDialog([]))

    expect(screen.queryByRole('button', { name: 'Drop PK' })).not.toBeInTheDocument()
    expect(columns.some(col => isChecked(col))).toBe(false)
  })

  it('re-checks the key from the live prop when reopened, discarding a stale selection', async () => {
    const user = userEvent.setup()
    const { rerender } = render(renderDialog(['id']))

    // Abandoned edit: the user ticks `status` but never saves.
    await user.click(screen.getByRole('button', { name: 'status' }))
    expect(isChecked('status')).toBe(true)

    rerender(
      <PrimaryKeyDialog
        open={false}
        onClose={vi.fn()}
        sessionId="session-1"
        database="app_db"
        table="users"
        columns={columns}
        currentPkColumns={['id']}
      />
    )
    // The key changes behind the dialog's back (another client added a column).
    rerender(
      <PrimaryKeyDialog
        open
        onClose={vi.fn()}
        sessionId="session-1"
        database="app_db"
        table="users"
        columns={columns}
        currentPkColumns={['email', 'status']}
      />
    )

    await waitFor(() => expect(isChecked('email')).toBe(true))
    expect(isChecked('status')).toBe(true)
    expect(isChecked('id')).toBe(false)
    expect(isChecked('tenant_id')).toBe(false)
  })
})

describe('PrimaryKeyDialog save payload', () => {
  it('posts the live key unchanged when the dialog is opened and saved untouched', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post(`${BASE}/sessions/:id/databases/:db/tables/:table/primary-key`, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true, sql: 'ALTER TABLE `users` DROP PRIMARY KEY' })
      })
    )

    render(renderDialog(['id', 'tenant_id']))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ columns: ['id', 'tenant_id'] })
  })
})
