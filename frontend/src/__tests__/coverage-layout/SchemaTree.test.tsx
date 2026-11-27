import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SchemaTree from '../../components/schema/SchemaTree'
import { useSchemaStore } from '../../store/schemaStore'
import { useTabStore } from '../../store/tabStore'
import { api } from '../../api/client'
import { showToast } from '../../utils/toast'
import type { TableInfo } from '../../types'

vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))

vi.mock('../../components/table/CreateTableDialog', () => ({
  default: ({ open, onClose, database, onCreated }: {
    open: boolean
    onClose: () => void
    database: string
    onCreated: () => void
  }) => (
    <div data-testid="create-table-dialog" data-open={String(open)} data-database={database}>
      <button type="button" onClick={onClose}>close create table</button>
      <button type="button" onClick={onCreated}>created table</button>
    </div>
  ),
}))

vi.mock('../../components/table/ImportDialog', () => ({
  default: ({ open, onClose, database, table }: {
    open: boolean
    onClose: () => void
    database: string
    table?: string
  }) => (
    <div
      data-testid="import-dialog"
      data-open={String(open)}
      data-database={database}
      data-table={table ?? 'none'}
    >
      <button type="button" onClick={onClose}>close import</button>
    </div>
  ),
}))

const SESSION = 'session-1'

function table(name: string, type = 'BASE TABLE'): TableInfo {
  return {
    name,
    table_type: type,
    engine: 'InnoDB',
    row_count: 1,
    data_length: 16384,
    comment: '',
  }
}

const initialSchema = useSchemaStore.getState()
const initialTabs = useTabStore.getState()
const openTableTab = vi.fn()
const openQueryTab = vi.fn()

function seed(overrides: Partial<ReturnType<typeof useSchemaStore.getState>> = {}) {
  useSchemaStore.setState({
    ...initialSchema,
    databases: {
      [SESSION]: ['app_db', 'analytics'],
    },
    dbErrors: {},
    tables: {
      [`${SESSION}/app_db`]: [table('zebra', 'VIEW'), table('alpha')],
      [`${SESSION}/analytics`]: [table('events')],
    },
    columns: {},
    rowKeys: {},
    loadingDbs: new Set(),
    loadingTables: new Set(),
    ...overrides,
  })
}

describe('SchemaTree coverage', () => {
  beforeEach(() => {
    localStorage.clear()
    seed()
    openTableTab.mockReset()
    openQueryTab.mockReset()
    useTabStore.setState({
      ...initialTabs,
      tabs: [],
      activeTabId: null,
      openTableTab,
      openQueryTab,
    })
    vi.mocked(showToast).mockClear()
    vi.spyOn(api, 'dropTable').mockResolvedValue({ ok: true })
    vi.spyOn(api, 'truncateTable').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('filters the visible schemas through the selected database list', () => {
    const view = render(<SchemaTree sessionId={SESSION} selectedDatabases={[]} />)
    expect(screen.getByTitle('app_db')).toBeInTheDocument()
    expect(screen.getByTitle('analytics')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter tables...')).toBeInTheDocument()

    view.rerender(<SchemaTree sessionId={SESSION} selectedDatabases={['app_db', 'missing']} />)
    expect(screen.getByTitle('app_db')).toBeInTheDocument()
    expect(screen.queryByTitle('analytics')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter selected schemas...')).toBeInTheDocument()
  })

  it('shows a loading state for the initial schema listing', () => {
    const loadDatabases = vi.fn(() => new Promise<string[]>(() => {}))
    seed({
      databases: {},
      loadingDbs: new Set([SESSION]),
      loadDatabases,
    })
    render(<SchemaTree sessionId={SESSION} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading databases…')
  })

  it('shows a database error with a retry action', () => {
    const loadDatabases = vi.fn().mockResolvedValue([])
    seed({
      databases: {},
      dbErrors: { [SESSION]: 'connection refused' },
      loadDatabases,
    })
    render(<SchemaTree sessionId={SESSION} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load databases: connection refused',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadDatabases).toHaveBeenCalledWith(SESSION)
  })

  it('expands and collapses a database, showing its loading announcement', async () => {
    const loadTables = vi.fn().mockResolvedValue([table('users')])
    seed({
      tables: {},
      loadTables,
    })
    render(<SchemaTree sessionId={SESSION} />)

    const appDb = screen.getByTitle('app_db')
    expect(appDb).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(appDb)

    await waitFor(() => expect(appDb).toHaveAttribute('aria-expanded', 'true'))
    expect(loadTables).toHaveBeenCalledWith(SESSION, 'app_db')
    expect(loadTables).toHaveBeenCalledTimes(1)

    fireEvent.click(appDb)
    expect(appDb).toHaveAttribute('aria-expanded', 'false')
    expect(loadTables).toHaveBeenCalledTimes(1)
  })

  it('announces tables while a schema is loading', () => {
    seed({
      tables: {},
      loadingTables: new Set([`${SESSION}/app_db`]),
    })
    render(<SchemaTree sessionId={SESSION} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading tables for app_db…')
    expect(screen.getByTitle('app_db')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTitle('app_db').querySelector('svg.animate-spin')).not.toBeNull()
  })

  it('filters schemas and tables by name while keeping unknown schemas visible', () => {
    seed({
      databases: { [SESSION]: ['app_db', 'analytics', 'user_stats'] },
      tables: {
        [`${SESSION}/app_db`]: [table('users'), table('orders')],
        [`${SESSION}/analytics`]: [table('events')],
        [`${SESSION}/user_stats`]: [table('totals')],
      },
    })
    const view = render(<SchemaTree sessionId={SESSION} />)
    const input = screen.getByPlaceholderText('Filter tables...')

    fireEvent.change(input, { target: { value: 'user' } })
    expect(screen.getByTitle('app_db.users')).toBeInTheDocument()
    expect(screen.queryByTitle('app_db.orders')).not.toBeInTheDocument()
    expect(screen.queryByTitle('analytics')).not.toBeInTheDocument()
    expect(screen.getByTitle('user_stats')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter 3 open schemas')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'app_db' } })
    expect(screen.getByTitle('app_db')).toBeInTheDocument()
    expect(screen.queryByTitle('analytics')).not.toBeInTheDocument()
    expect(screen.queryByTitle('user_stats')).not.toBeInTheDocument()

    act(() => {
      useSchemaStore.setState(s => ({
        tables: { ...s.tables, [`${SESSION}/user_stats`]: [table('users_archive')] },
      }))
    })
    fireEvent.change(input, { target: { value: 'users' } })
    expect(screen.getByTitle('app_db.users')).toBeInTheDocument()
    expect(screen.getByTitle('user_stats.users_archive')).toBeInTheDocument()
    expect(screen.queryByTitle('analytics')).not.toBeInTheDocument()
    view.unmount()
  })

  it('keeps unknown schemas visible under search and uses one or many open-schema labels', async () => {
    seed({
      databases: { [SESSION]: ['app_db', 'analytics'] },
      tables: {
        [`${SESSION}/app_db`]: [table('users')],
      },
    })
    const loadTablesBatch = vi.fn().mockResolvedValue(undefined)
    const loadTables = vi.fn().mockResolvedValue([])
    useSchemaStore.setState({ loadTablesBatch, loadTables })
    render(<SchemaTree sessionId={SESSION} />)
    const input = screen.getByPlaceholderText('Filter tables...')

    fireEvent.change(input, { target: { value: 'use' } })
    expect(screen.getByPlaceholderText('Filter 2 open schemas')).toBeInTheDocument()
    expect(screen.getByTitle('analytics')).toBeInTheDocument()
    expect(loadTablesBatch).toHaveBeenCalledWith(SESSION, ['app_db', 'analytics'])

    fireEvent.click(screen.getByTitle('analytics'))
    expect(screen.queryByTitle('analytics')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'user' } })
    expect(screen.getByPlaceholderText('Filter app_db')).toBeInTheDocument()
    expect(loadTablesBatch).toHaveBeenLastCalledWith(SESSION, ['app_db'])
  })

  it('clears search with Escape and the clear button', () => {
    render(<SchemaTree sessionId={SESSION} />)
    const input = screen.getByPlaceholderText('Filter tables...')

    fireEvent.change(input, { target: { value: 'users' } })
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'x' })
    expect(input).toHaveValue('users')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(input).not.toHaveFocus()

    fireEvent.change(input, { target: { value: 'orders' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveValue('')
  })

  it('sorts tables case-insensitively without mutating the cache', () => {
    const unsorted = [table('zeta'), table('Alpha'), table('beta')]
    seed({ tables: { [`${SESSION}/app_db`]: unsorted } })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByTitle('app_db'))
    const titles = Array.from(document.querySelectorAll('[title^="app_db."]'))
      .map(node => node.getAttribute('title'))
    expect(titles).toEqual(['app_db.Alpha', 'app_db.beta', 'app_db.zeta'])
    expect(useSchemaStore.getState().tables[`${SESSION}/app_db`]).toBe(unsorted)
  })

  it('toggles bookmarks and survives unavailable storage', async () => {
    const user = userEvent.setup()
    render(<SchemaTree sessionId={SESSION} />)
    const star = await screen.findByRole('button', { name: 'Bookmark app_db.alpha' })

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    fireEvent.click(star)
    expect(screen.getByRole('button', { name: 'Remove bookmark from app_db.alpha' })).toBeInTheDocument()

    vi.mocked(window.localStorage.setItem).mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Remove bookmark from app_db.alpha' }))
    expect(screen.getByRole('button', { name: 'Bookmark app_db.alpha' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(`lagun-bookmarks-${SESSION}`) ?? '[]')).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Show bookmarks only' }))
    expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter bookmarks...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all tables' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all tables' }))
  })

  it('renders only bookmarked tables and includes unknown schemas with a bookmark', () => {
    localStorage.setItem(
      `lagun-bookmarks-${SESSION}`,
      JSON.stringify(['app_db/alpha', 'analytics/events']),
    )
    seed({
      tables: {
        [`${SESSION}/app_db`]: [table('alpha'), table('zebra')],
      },
    })
    const loadTablesBatch = vi.fn().mockResolvedValue(undefined)
    useSchemaStore.setState({ loadTablesBatch })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show bookmarks only' }))
    expect(screen.getByTitle('app_db.alpha')).toBeInTheDocument()
    expect(screen.queryByTitle('app_db.zebra')).not.toBeInTheDocument()
    expect(screen.getByTitle('analytics')).toBeInTheDocument()
    expect(loadTablesBatch).toHaveBeenCalledWith(SESSION, ['app_db', 'analytics'])
  })

  it('recovers from invalid persisted bookmarks', () => {
    localStorage.setItem(`lagun-bookmarks-${SESSION}`, '{not json')
    render(<SchemaTree sessionId={SESSION} />)
    expect(screen.getByRole('button', { name: 'Bookmark app_db.alpha' })).toBeInTheDocument()
  })

  it('opens database and table context actions and keeps menus inside the viewport', async () => {
    render(<SchemaTree sessionId={SESSION} />)
    const appDb = screen.getByTitle('app_db')
    fireEvent.contextMenu(appDb, { clientX: 20, clientY: 20 })
    expect(appDb).toHaveFocus()
    expect(screen.getByRole('menu', { name: 'Schema actions' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'New Query' }))
    expect(openQueryTab).toHaveBeenCalledWith(SESSION, 'app_db')
    expect(screen.queryByRole('menu', { name: 'Schema actions' })).not.toBeInTheDocument()

    fireEvent.contextMenu(appDb, { clientX: 5000, clientY: 5000 })
    const menu = screen.getByRole('menu', { name: 'Schema actions' })
    const floating = menu.closest<HTMLElement>('.fixed')!
    await waitFor(() => expect(floating.style.left).not.toBe(''))
    expect(floating.style.left).toBe(`${window.innerWidth - floating.offsetWidth - 8}px`)
    expect(floating.style.top).toBe(`${window.innerHeight - floating.offsetHeight - 8}px`)
    fireEvent.click(menu)
    expect(screen.getByRole('menu', { name: 'Schema actions' })).toBeInTheDocument()
    fireEvent.click(document.body)
    expect(screen.queryByRole('menu', { name: 'Schema actions' })).not.toBeInTheDocument()

    const users = screen.getByTitle('app_db.zebra')
    fireEvent.contextMenu(users, { clientX: 30, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Table' }))
    expect(openTableTab).toHaveBeenCalledWith(SESSION, 'app_db', 'zebra')

    fireEvent.contextMenu(screen.getByTitle('app_db.zebra'), { clientX: 30, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Query' }))
    expect(openQueryTab).toHaveBeenCalledWith(SESSION, 'app_db')

    fireEvent.contextMenu(screen.getByTitle('app_db.zebra'), { clientX: 30, clientY: 30 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Schema actions' })).not.toBeInTheDocument()
  })

  it('mounts lazy create and import dialogs on first open and keeps them mounted', async () => {
    render(<SchemaTree sessionId={SESSION} />)
    expect(screen.queryByTestId('create-table-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByTitle('app_db'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create Table' }))
    expect(await screen.findByTestId('create-table-dialog')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('create-table-dialog')).toHaveAttribute('data-database', 'app_db')
    fireEvent.click(screen.getByRole('button', { name: 'close create table' }))
    expect(screen.getByTestId('create-table-dialog')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('create-table-dialog')).toHaveAttribute('data-database', '')
    fireEvent.contextMenu(screen.getByTitle('app_db.zebra'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import CSV' }))
    expect(await screen.findByTestId('import-dialog')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-database', 'app_db')
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-table', 'zebra')
    fireEvent.click(screen.getByRole('button', { name: 'close import' }))
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-database', '')
    expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-table', 'none')
  })

  it('truncates a table after confirmation and reports failures', async () => {
    const user = userEvent.setup()
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.contextMenu(screen.getByTitle('app_db.alpha'))
    await user.click(screen.getByRole('menuitem', { name: 'Truncate' }))
    expect(screen.getByRole('alertdialog', { name: 'Truncate Table' })).toBeInTheDocument()
    expect(screen.getByText(/All rows will be deleted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Truncate Table' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Truncated app_db.alpha.'))

    vi.mocked(api.truncateTable).mockRejectedValueOnce(new Error('locked'))
    fireEvent.contextMenu(screen.getByTitle('app_db.alpha'))
    await user.click(screen.getByRole('menuitem', { name: 'Truncate' }))
    await user.click(screen.getByRole('button', { name: 'Truncate Table' }))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Could not truncate app_db.alpha: Error: locked',
        'error',
      ),
    )
  })

  it('can cancel a destructive action', async () => {
    const user = userEvent.setup()
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.contextMenu(screen.getByTitle('app_db.alpha'))
    await user.click(screen.getByRole('menuitem', { name: 'Drop Table' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.dropTable).not.toHaveBeenCalled()
  })

  it('drops a table, removes it from cache, and invalidates its columns', async () => {
    seed({
      columns: { [`${SESSION}/app_db/zebra`]: [] },
    })
    const user = userEvent.setup()
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.contextMenu(screen.getByTitle('app_db.zebra'))
    await user.click(screen.getByRole('menuitem', { name: 'Drop Table' }))
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Drop Table' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Dropped app_db.zebra.'))
    expect(screen.queryByTitle('app_db.zebra')).not.toBeInTheDocument()
    expect(useSchemaStore.getState().columns[`${SESSION}/app_db/zebra`]).toBeUndefined()
  })

  it('drops a table whose cached list was already removed and reports failures', async () => {
    const user = userEvent.setup()
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.contextMenu(screen.getByTitle('app_db.alpha'))
    act(() => useSchemaStore.setState({ tables: {} }))
    await user.click(screen.getByRole('menuitem', { name: 'Drop Table' }))
    await user.click(screen.getByRole('button', { name: 'Drop Table' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Dropped app_db.alpha.'))

    vi.mocked(api.dropTable).mockRejectedValueOnce('permission denied')
    act(() => seed())
    fireEvent.contextMenu(screen.getByTitle('app_db.alpha'))
    await user.click(screen.getByRole('menuitem', { name: 'Drop Table' }))
    await user.click(screen.getByRole('button', { name: 'Drop Table' }))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Could not drop app_db.alpha: permission denied',
        'error',
      ),
    )
  })

  it('refreshes databases, restores open groups, and clears the filter', async () => {
    const invalidateSession = vi.fn()
    const loadDatabases = vi.fn().mockResolvedValue(['app_db', 'analytics'])
    const loadTablesBatch = vi.fn().mockResolvedValue(undefined)
    useSchemaStore.setState({ invalidateSession, loadDatabases, loadTablesBatch })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByTitle('app_db'))
    await waitFor(() =>
      expect(screen.getByTitle('app_db')).toHaveAttribute('aria-expanded', 'true'),
    )
    const filter = screen.getByPlaceholderText('Filter tables...')
    fireEvent.change(filter, { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))

    await waitFor(() => expect(filter).toHaveValue(''))
    expect(invalidateSession).toHaveBeenCalledWith(SESSION)
    expect(loadTablesBatch).toHaveBeenCalledWith(SESSION, ['app_db'])
    expect(screen.getByTitle('app_db')).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps the filter and reports a database-listing failure on refresh', async () => {
    const loadDatabases = vi.fn().mockImplementation(async () => {
      useSchemaStore.setState({ dbErrors: { [SESSION]: 'listing down' } })
      return []
    })
    useSchemaStore.setState({
      invalidateSession: vi.fn(),
      loadDatabases,
      loadTablesBatch: vi.fn().mockResolvedValue(undefined),
    })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByTitle('app_db'))
    const filter = screen.getByPlaceholderText('Filter tables...')
    fireEvent.change(filter, { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Could not refresh schemas: listing down',
        'error',
      ),
    )
    expect(screen.getByTitle('app_db')).toHaveAttribute('aria-expanded', 'true')
    expect(filter).toHaveValue('alpha')
  })

  it('reports a non-Error batch failure on refresh', async () => {
    useSchemaStore.setState({
      invalidateSession: vi.fn(),
      loadDatabases: vi.fn().mockResolvedValue(['app_db', 'analytics']),
      loadTablesBatch: vi.fn().mockRejectedValue('batch offline'),
    })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByTitle('app_db'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Could not refresh schemas: batch offline',
        'error',
      ),
    )
  })

  it('closes groups that disappeared during a successful refresh', async () => {
    useSchemaStore.setState({
      invalidateSession: vi.fn(),
      loadDatabases: vi.fn().mockResolvedValue([]),
      loadTablesBatch: vi.fn().mockResolvedValue(undefined),
    })
    render(<SchemaTree sessionId={SESSION} />)

    fireEvent.click(screen.getByTitle('app_db'))
    const filter = screen.getByPlaceholderText('Filter tables...')
    fireEvent.change(filter, { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))

    await waitFor(() => expect(filter).toHaveValue(''))
    expect(screen.getByTitle('app_db')).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a query for a database from its shortcut', () => {
    render(<SchemaTree sessionId={SESSION} />)
    fireEvent.click(screen.getByRole('button', { name: 'New query on app_db' }))
    expect(openQueryTab).toHaveBeenCalledWith(SESSION, 'app_db')
  })

  it('opens a table from its row', () => {
    render(<SchemaTree sessionId={SESSION} />)
    fireEvent.click(screen.getByTitle('app_db.zebra'))
    expect(openTableTab).toHaveBeenCalledWith(SESSION, 'app_db', 'zebra')
  })

  it('renders an empty database list without treating it as a loading error', () => {
    seed({ databases: { [SESSION]: [] } })
    render(<SchemaTree sessionId={SESSION} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByTitle('app_db')).not.toBeInTheDocument()
  })
})
