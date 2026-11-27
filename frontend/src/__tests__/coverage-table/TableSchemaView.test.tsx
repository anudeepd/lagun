import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TableSchemaView from '../../components/table/TableSchemaView'
import { api } from '../../api/client'
import { clipboardWrite } from '../../utils/clipboard'
import { showToast } from '../../utils/toast'
import type { ColumnInfo, IndexInfo, TableInfo } from '../../types'

vi.mock('../../api/client', () => ({
  api: {
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTables: vi.fn(),
    truncateTable: vi.fn(),
    dropColumn: vi.fn(),
    dropIndex: vi.fn(),
    getCreateSql: vi.fn(),
    analyzeTable: vi.fn(),
    addColumn: vi.fn(),
    modifyColumn: vi.fn(),
    setPrimaryKey: vi.fn(),
    dropPrimaryKey: vi.fn(),
    createIndex: vi.fn(),
  },
}))

const { mockLoadColumns, mockInvalidateTable, schemaStoreState } = vi.hoisted(() => ({
  mockLoadColumns: vi.fn(),
  mockInvalidateTable: vi.fn(),
  schemaStoreState: { columns: {} as Record<string, ColumnInfo[]> },
}))

vi.mock('../../store/schemaStore', () => ({
  useSchemaStore: (selector: (state: {
    columns: Record<string, ColumnInfo[]>
    loadColumns: typeof mockLoadColumns
    invalidateTable: typeof mockInvalidateTable
  }) => unknown) => selector({
    ...schemaStoreState,
    loadColumns: mockLoadColumns,
    invalidateTable: mockInvalidateTable,
  }),
}))

vi.mock('../../utils/clipboard', () => ({
  clipboardWrite: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/toast', () => ({
  showToast: vi.fn(),
}))

const getColumns = vi.mocked(api.getColumns)
const getIndexes = vi.mocked(api.getIndexes)
const getTables = vi.mocked(api.getTables)
const analyzeTable = vi.mocked(api.analyzeTable)
const truncateTable = vi.mocked(api.truncateTable)
const dropColumn = vi.mocked(api.dropColumn)
const dropIndex = vi.mocked(api.dropIndex)
const getCreateSql = vi.mocked(api.getCreateSql)
const writeClipboard = vi.mocked(clipboardWrite)

const columns: ColumnInfo[] = [
  {
    name: 'id',
    data_type: 'int',
    column_type: 'INT',
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    is_auto_increment: true,
    extra: 'auto_increment',
    comment: '',
  },
  {
    name: 'status',
    data_type: 'varchar',
    column_type: 'VARCHAR(20)',
    is_nullable: true,
    column_default: 'pending',
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: 'current state',
  },
]

const indexes: IndexInfo[] = [
  { name: 'PRIMARY', columns: ['id'], is_unique: true, index_type: 'BTREE' },
  { name: 'idx_status', columns: ['status'], is_unique: false, index_type: 'HASH' },
]

const tableInfo: TableInfo = {
  name: 'users',
  table_type: 'BASE TABLE',
  engine: 'InnoDB',
  row_count: 1234,
  data_length: 2048,
  comment: 'Application users',
}

const props = {
  sessionId: 'session-1',
  database: 'app_db',
  table: 'users',
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitForSchema() {
  await screen.findByRole('columnheader', { name: '#' })
}

describe('TableSchemaView data and layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
    writeClipboard.mockResolvedValue(undefined)
  })

  it('loads columns, indexes, table metrics, and refreshes the schema cache', async () => {
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    expect(screen.getByText('Engine:')).toBeInTheDocument()
    expect(screen.getByText('InnoDB')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText('Application users')).toBeInTheDocument()
    const columnsTable = screen.getByRole('table', { name: 'Table columns' })
    expect(within(columnsTable).getByText('id')).toBeInTheDocument()
    expect(within(columnsTable).getByText('NULL')).toBeInTheDocument()
    expect(within(columnsTable).getByText('PRI')).toBeInTheDocument()
    expect(within(columnsTable).getByText('current state')).toBeInTheDocument()
    expect(screen.getByText('idx_status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drop column id' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drop index PRIMARY' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drop index idx_status' })).toBeInTheDocument()
    expect(mockInvalidateTable).toHaveBeenCalledWith('session-1', 'app_db', 'users')
    expect(mockLoadColumns).toHaveBeenCalledWith('session-1', 'app_db', 'users')
  })

  it('shows the full loading state when there is no cached schema', async () => {
    const pending = deferred<ColumnInfo[]>()
    getColumns.mockImplementationOnce(() => pending.promise)

    render(<TableSchemaView {...props} />)
    expect(screen.getByText(/Loading columns, indexes/)).toBeInTheDocument()
    pending.resolve(columns)
    await waitForSchema()
  })

  it('renders cached columns and an inline spinner while refreshing', async () => {
    const pending = deferred<ColumnInfo[]>()
    schemaStoreState.columns = { 'session-1/app_db/users': columns }
    getColumns.mockImplementationOnce(() => pending.promise)

    render(<TableSchemaView {...props} />)
    await waitForSchema()
    expect(document.querySelector('.animate-spin')).not.toBeNull()
    pending.resolve(columns)
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull())
  })

  it('renders empty indexes and omits a missing table info bar', async () => {
    getIndexes.mockResolvedValueOnce([])
    getTables.mockResolvedValueOnce([])
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    expect(screen.getByText('No indexes')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Refresh Stats/ })).not.toBeInTheDocument()
  })

  it.each([
    [null, null, null, '', '—', true],
    [512, 0, 'MEMORY', 'small', '512 B', false],
    [2 * 1024 * 1024, null, null, '', '2.0 MB', true],
  ])(
    'formats table metrics for data length %s',
    async (dataLength, rowCount, engine, comment, dataLabel, hidesMetrics) => {
      getTables.mockResolvedValueOnce([{
        ...tableInfo,
        engine,
        row_count: rowCount,
        data_length: dataLength,
        comment,
      }])

      render(<TableSchemaView {...props} />)
      await waitForSchema()

      expect(screen.getByText(dataLabel)).toBeInTheDocument()
      if (hidesMetrics) {
        expect(screen.queryByText(/Rows:/)).not.toBeInTheDocument()
        expect(screen.queryByText(/Engine:/)).not.toBeInTheDocument()
      }
      if (comment) expect(screen.getByText(comment)).toBeInTheDocument()
    },
  )

  it('reloads for a new refresh trigger and ignores an equal trigger', async () => {
    const view = render(<TableSchemaView {...props} refreshTrigger={0} />)
    await waitForSchema()
    expect(getColumns).toHaveBeenCalledTimes(1)

    view.rerender(<TableSchemaView {...props} refreshTrigger={1} />)
    await waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2))
    view.rerender(<TableSchemaView {...props} refreshTrigger={1} />)
    expect(getColumns).toHaveBeenCalledTimes(2)
  })
})

describe('TableSchemaView statistics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
  })

  it('refreshes stats on demand and shows the updated values', async () => {
    const user = userEvent.setup()
    analyzeTable
      .mockResolvedValueOnce({ ok: true, analyzed: false, row_count: 1234, data_length: 2048 })
      .mockResolvedValueOnce({ ok: true, analyzed: true, row_count: 4242, data_length: 2048 })
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: /Refresh Stats/i }))
    await waitFor(() => expect(screen.getByText('4,242')).toBeInTheDocument())
    expect(analyzeTable).toHaveBeenLastCalledWith('session-1', 'app_db', 'users', true)
    expect(showToast).toHaveBeenCalledWith('Refreshed statistics for app_db.users.', 'success')
  })

  it('surfaces a forced stats failure and re-enables the action', async () => {
    const user = userEvent.setup()
    analyzeTable
      .mockResolvedValueOnce({ ok: true, analyzed: false, row_count: 1, data_length: 1 })
      .mockRejectedValueOnce('analyze unavailable')
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: /Refresh Stats/i }))
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Error refreshing statistics: analyze unavailable',
        'error',
      )
    })
    expect(screen.getByRole('button', { name: /Refresh Stats/i })).toBeEnabled()
  })

  it('keeps automatic stats failures quiet and leaves missing table info absent', async () => {
    getTables.mockResolvedValueOnce([])
    analyzeTable.mockRejectedValueOnce(new Error('automatic analyze failed'))
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await waitFor(() => expect(analyzeTable).toHaveBeenCalledOnce())
    expect(showToast).not.toHaveBeenCalled()
    expect(screen.queryByText('Engine:')).not.toBeInTheDocument()
  })
})

describe('TableSchemaView schema export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
    writeClipboard.mockResolvedValue(undefined)
  })

  it('opens the formatted CREATE statement and copies it', async () => {
    const user = userEvent.setup()
    getCreateSql.mockResolvedValue({
      create_sql: 'CREATE TABLE `users` (\n  `id` int\n) ENGINE=InnoDB',
    })
    render(<TableSchemaView {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Schema/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Export Schema/i }))
    const dialog = await screen.findByRole('dialog', { name: /CREATE statement/i })
    expect(dialog).toHaveTextContent('DROP TABLE IF EXISTS `users`')
    expect(dialog).toHaveTextContent('CREATE TABLE IF NOT EXISTS')

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument(),
      { timeout: 3_000 },
    )
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /CREATE statement/i })).not.toBeInTheDocument())
  })

  it('downloads the CREATE statement as a SQL file', async () => {
    const user = userEvent.setup()
    getCreateSql.mockResolvedValue({ create_sql: 'SHOW CREATE TABLE `users`' })
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob
      return 'blob:schema'
    })
    const revokeObjectURL = vi.fn()
    let downloadedBlob: Blob | null = null
    let downloadedName = ''
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download
    })

    try {
      render(<TableSchemaView {...props} />)
      await waitFor(() => expect(screen.getByRole('button', { name: /Export Schema/i })).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: /Export Schema/i }))
      await screen.findByRole('dialog', { name: /CREATE statement/i })
      await user.click(screen.getByRole('button', { name: 'Download' }))

      expect(downloadedName).toBe('app_db_users_create.sql')
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:schema')
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error)
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(downloadedBlob!)
      })
      expect(text).toBe('DROP TABLE IF EXISTS `users`;\nSHOW CREATE TABLE `users`;\n')
    } finally {
      click.mockRestore()
    }
  })

  it.each([
    [new Error('permission denied'), 'Error loading CREATE statement: permission denied'],
    ['permission denied', 'Error loading CREATE statement: permission denied'],
  ])('surfaces a failed CREATE statement request', async (failure, expected) => {
    const user = userEvent.setup()
    getCreateSql.mockRejectedValueOnce(failure)
    render(<TableSchemaView {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Schema/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Export Schema/i }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expected, 'error'))
    expect(screen.queryByRole('dialog', { name: /CREATE statement/i })).not.toBeInTheDocument()
  })
})

describe('TableSchemaView destructive actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
    truncateTable.mockResolvedValue({ ok: true })
    dropColumn.mockResolvedValue({ ok: true })
    dropIndex.mockResolvedValue({ ok: true })
  })

  it('truncates after confirmation', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: 'Truncate' }))
    await user.click(screen.getByRole('button', { name: 'Truncate Table' }))

    await waitFor(() => expect(truncateTable).toHaveBeenCalledWith('session-1', 'app_db', 'users'))
    expect(showToast).toHaveBeenCalledWith('Table truncated.', 'success')
    expect(screen.queryByRole('alertdialog', { name: 'Truncate Table' })).not.toBeInTheDocument()
  })

  it('reports a failed truncate and closes the confirmation', async () => {
    const user = userEvent.setup()
    truncateTable.mockRejectedValueOnce('truncate denied')
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: 'Truncate' }))
    await user.click(screen.getByRole('button', { name: 'Truncate Table' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('truncate denied', 'success'))
    expect(screen.queryByRole('alertdialog', { name: 'Truncate Table' })).not.toBeInTheDocument()
  })

  it('drops a column, reloads the schema, and reports failure', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: 'Drop column status' }))
    await user.click(screen.getByRole('button', { name: 'Drop Column' }))
    await waitFor(() => expect(dropColumn).toHaveBeenCalledWith('session-1', 'app_db', 'users', 'status'))
    expect(showToast).toHaveBeenCalledWith('Column status dropped.', 'success')
    await waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2))

    dropColumn.mockRejectedValueOnce(new Error('denied'))
    await user.click(screen.getByRole('button', { name: 'Drop column status' }))
    await user.click(screen.getByRole('button', { name: 'Drop Column' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Error: denied', 'error'))
  })

  it('drops an index from the visible list', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: 'Drop index idx_status' }))
    await user.click(screen.getByRole('button', { name: 'Drop Index' }))
    await waitFor(() => expect(dropIndex).toHaveBeenCalledWith('session-1', 'app_db', 'users', 'idx_status'))
    expect(screen.queryByText('idx_status')).not.toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith('Index idx_status dropped.', 'success')
  })

  it('reports a failed index drop and keeps the index visible', async () => {
    const user = userEvent.setup()
    dropIndex.mockRejectedValueOnce(new Error('index locked'))
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: 'Drop index idx_status' }))
    await user.click(screen.getByRole('button', { name: 'Drop Index' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Error: index locked', 'error'))
    expect(screen.getByText('idx_status')).toBeInTheDocument()
  })

  it('closes each destructive confirmation without running it', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    for (const [trigger, dialog] of [
      ['Truncate', 'Truncate Table'],
      ['Drop column status', 'Drop Column'],
      ['Drop index idx_status', 'Drop Index'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: trigger }))
      expect(screen.getByRole('alertdialog', { name: dialog })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog', { name: dialog })).not.toBeInTheDocument())
    }
    expect(truncateTable).not.toHaveBeenCalled()
    expect(dropColumn).not.toHaveBeenCalled()
    expect(dropIndex).not.toHaveBeenCalled()
  })
})

describe('TableSchemaView child dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = { 'session-1/app_db/users': columns }
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
    vi.mocked(api.addColumn).mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    vi.mocked(api.modifyColumn).mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    vi.mocked(api.setPrimaryKey).mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    vi.mocked(api.dropPrimaryKey).mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    vi.mocked(api.createIndex).mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
  })

  it('adds and edits columns through the schema actions', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()

    await user.click(screen.getByRole('button', { name: /Add Column/i }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'created_at')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.addColumn).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Add Column to users/i })).not.toBeInTheDocument())

    await user.click(screen.getAllByRole('button', { name: 'Edit column' })[0])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Column/ })).not.toBeInTheDocument())
    await user.click(screen.getAllByRole('button', { name: 'Edit column' })[0])
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.modifyColumn).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit Column/ })).not.toBeInTheDocument())
  })

  it('closes the primary key and index dialogs through their parent callbacks', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...props} />)
    await waitForSchema()
    const initialLoads = getColumns.mock.calls.length

    await user.click(screen.getByRole('button', { name: /Manage PK/i }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(getColumns.mock.calls.length).toBe(initialLoads + 1))

    await user.click(screen.getByRole('button', { name: /Add Index/i }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(getColumns.mock.calls.length).toBe(initialLoads + 2))
  })
})

describe('TableSchemaView load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    getColumns.mockResolvedValue(columns)
    getIndexes.mockResolvedValue(indexes)
    getTables.mockResolvedValue([tableInfo])
    analyzeTable.mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
  })

  it.each([
    [new Error('Unknown table'), 'Error loading schema: Unknown table'],
    ['Unknown table', 'Error loading schema: Unknown table'],
  ])('reports a schema load failure', async (failure, expected) => {
    getColumns.mockRejectedValueOnce(failure)
    render(<TableSchemaView {...props} />)
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expected, 'error'))
  })

  it('stays silent for an already-aborted signal and an AbortError', async () => {
    getColumns
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
      .mockImplementationOnce((_sessionId, _database, _table, signal) =>
        new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('aborted signal'))
          else signal?.addEventListener('abort', () => reject(new Error('aborted signal')))
        }))

    const view = render(<TableSchemaView {...props} />)
    await waitFor(() => expect(getColumns).toHaveBeenCalledOnce())
    view.rerender(<TableSchemaView {...props} sessionId="session-2" />)
    await waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2))
    expect(showToast).not.toHaveBeenCalled()
  })
})
