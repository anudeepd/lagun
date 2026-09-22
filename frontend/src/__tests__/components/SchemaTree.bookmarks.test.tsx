import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSchemaStore } from '../../store/schemaStore'
import SchemaTree from '../../components/schema/SchemaTree'

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

describe('SchemaTree bookmarks', () => {
  beforeEach(() => {
    localStorage.clear()
    useSchemaStore.setState({
      databases: { [SESSION]: ['app_db'] },
      dbErrors: {},
      tables: { [`${SESSION}/app_db`]: [table('users'), table('orders')] },
      columns: {},
      loadingDbs: new Set(),
      loadingTables: new Set(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('stays usable when the browser refuses to persist the bookmark', async () => {
    render(<SchemaTree sessionId={SESSION} />)

    const star = await screen.findByRole('button', { name: `Bookmark app_db.users` })
    // Quota / private-mode failures throw out of `localStorage.setItem`; that
    // used to happen inside the state updater, taking the whole sidebar down.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })

    fireEvent.click(star)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: `Remove bookmark from app_db.users` })).toBeInTheDocument(),
    )
    expect(screen.getByText('orders')).toBeInTheDocument()
  })

  it('persists the bookmark when the browser accepts it', async () => {
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(await screen.findByRole('button', { name: `Bookmark app_db.orders` }))

    await waitFor(() => expect(JSON.parse(localStorage.getItem(`lagun-bookmarks-${SESSION}`) ?? '[]')).toEqual(['app_db/orders']))
  })
})
