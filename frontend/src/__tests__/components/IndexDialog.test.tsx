import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import IndexDialog from '../../components/table/IndexDialog'
import { server } from '../server'

const BASE = 'http://localhost/api/v1'

/** Intercept the create-index POST and record the JSON body the browser actually sent. */
function captureIndexRequests(): unknown[] {
  const bodies: unknown[] = []
  server.use(
    http.post(`${BASE}/sessions/:id/databases/:db/tables/:table/indexes`, async ({ request }) => {
      bodies.push(await request.json())
      return HttpResponse.json(
        { ok: true, sql: 'CREATE UNIQUE INDEX `idx_email` ON `app_db`.`users` (`email`) USING BTREE' },
        { status: 201 }
      )
    })
  )
  return bodies
}

describe('IndexDialog request contract', () => {
  it('posts the backend field name `unique`, not `is_unique`', async () => {
    const bodies = captureIndexRequests()

    render(
      <IndexDialog
        open
        onClose={vi.fn()}
        sessionId="session-1"
        database="app_db"
        table="users"
        columns={['id', 'email']}
      />
    )

    await userEvent.type(screen.getByRole('textbox', { name: 'Index Name' }), 'idx_email')
    await userEvent.click(screen.getByRole('button', { name: 'email' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Unique' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      name: 'idx_email',
      columns: ['email'],
      unique: true,
      index_type: 'BTREE',
    })
  })
})
