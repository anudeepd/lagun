import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { useSchemaStore } from '../../store/schemaStore'
import SchemaTree from '../../components/schema/SchemaTree'

vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))
import { showToast } from '../../utils/toast'

const BASE = 'http://localhost/api/v1'
const SESSION = 'session-1'

describe('SchemaTree refresh', () => {
  beforeEach(() => {
    useSchemaStore.setState({
      databases: {},
      tables: {},
      columns: {},
      loadingDbs: new Set(),
      loadingTables: new Set(),
      dbErrors: {},
    })
    vi.mocked(showToast).mockClear()
  })

  it('keeps the filter and reports the failure when the database listing fails', async () => {
    render(<SchemaTree sessionId={SESSION} />)
    await waitFor(() =>
      expect(useSchemaStore.getState().databases[SESSION]).toEqual(['app_db', 'analytics']),
    )

    fireEvent.click(screen.getByTitle('app_db'))
    const filter = screen.getByPlaceholderText('Filter tables...')
    fireEvent.change(filter, { target: { value: 'users' } })

    // The listing endpoint starts failing: a refresh must not behave as though
    // the connection simply has no schemas.
    server.use(
      http.get(`${BASE}/sessions/:id/databases`, () => new HttpResponse(null, { status: 500 })),
    )
    fireEvent.click(screen.getByLabelText('Refresh databases'))

    await waitFor(() => expect(vi.mocked(showToast)).toHaveBeenCalled())
    expect(vi.mocked(showToast).mock.calls[0][0]).toMatch(/Could not refresh schemas/)
    // A collapsed tree with an erased filter was the pre-fix outcome: the
    // resolved-with-[] failure took the success branch.
    expect(filter).toHaveValue('users')
  })
})
