import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { useSchemaStore } from '../../store/schemaStore'
import SchemaTree from '../../components/schema/SchemaTree'

const BASE = 'http://localhost/api/v1'
const SESSION = 'session-1'

function table(name: string) {
  return {
    name,
    table_type: 'BASE TABLE',
    engine: 'InnoDB',
    row_count: 2,
    data_length: 16384,
    comment: '',
  }
}

describe('SchemaTree search', () => {
  beforeEach(() => {
    useSchemaStore.setState({
      databases: {},
      tables: {},
      columns: {},
      loadingDbs: new Set(),
      loadingTables: new Set(),
    })
  })

  it('keeps schema names visible while their table lists are still loading', async () => {
    let releaseTables = () => {}
    const tablesArrived = new Promise<void>(resolve => { releaseTables = resolve })

    server.use(
      http.get(`${BASE}/sessions/:id/tables`, async () => {
        await tablesArrived
        return HttpResponse.json({ app_db: [table('users')], analytics: [table('events')] })
      }),
    )

    render(<SchemaTree sessionId={SESSION} />)
    await waitFor(() =>
      expect(useSchemaStore.getState().databases[SESSION]).toEqual(['app_db', 'analytics']),
    )

    fireEvent.change(screen.getByPlaceholderText('Filter tables...'), { target: { value: 'users' } })

    // Tables are still in flight: neither schema can be excluded yet.
    expect(useSchemaStore.getState().loadingTables.size).toBe(2)
    expect(screen.getByText('app_db')).toBeInTheDocument()
    expect(screen.getByText('analytics')).toBeInTheDocument()

    releaseTables()

    // Once loaded, only the schema that actually matches stays in the list.
    await waitFor(() => expect(screen.getByText('users')).toBeInTheDocument())
    await waitFor(() => expect(screen.queryByText('analytics')).not.toBeInTheDocument())
    expect(screen.getByText('app_db')).toBeInTheDocument()
  })

  it('searches every schema in scope with a single request', async () => {
    const requested: string[][] = []
    server.use(
      http.get(`${BASE}/sessions/:id/tables`, ({ request }) => {
        const databases = new URL(request.url).searchParams.getAll('databases')
        requested.push(databases)
        return HttpResponse.json({
          app_db: [table('users')],
          analytics: [table('users_archive')],
        })
      }),
    )

    render(<SchemaTree sessionId={SESSION} />)
    await waitFor(() =>
      expect(useSchemaStore.getState().databases[SESSION]).toEqual(['app_db', 'analytics']),
    )

    fireEvent.change(screen.getByPlaceholderText('Filter tables...'), { target: { value: 'users' } })

    await waitFor(() => expect(screen.getByText('users_archive')).toBeInTheDocument())
    expect(screen.getByText('users')).toBeInTheDocument()
    expect(requested).toEqual([['app_db', 'analytics']])
    expect(useSchemaStore.getState().loadingTables.size).toBe(0)
  })

  it('does not re-request schemas whose tables are already loaded', async () => {
    const requested: string[][] = []
    server.use(
      http.get(`${BASE}/sessions/:id/tables`, ({ request }) => {
        const databases = new URL(request.url).searchParams.getAll('databases')
        requested.push(databases)
        return HttpResponse.json(Object.fromEntries(databases.map(db => [db, [table('users')]])))
      }),
    )

    render(<SchemaTree sessionId={SESSION} />)
    await waitFor(() =>
      expect(useSchemaStore.getState().databases[SESSION]).toEqual(['app_db', 'analytics']),
    )

    const input = screen.getByPlaceholderText('Filter tables...')
    fireEvent.change(input, { target: { value: 'u' } })
    await waitFor(() => expect(screen.getAllByText('users').length).toBe(2))

    fireEvent.change(input, { target: { value: 'us' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(requested).toEqual([['app_db', 'analytics']])
  })
})
