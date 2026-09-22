import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TableSchemaView from '../../../components/table/TableSchemaView'
import { api } from '../../../api/client'

vi.mock('../../../api/client', () => ({
  api: {
    getColumns: vi.fn(),
    getIndexes: vi.fn(),
    getTables: vi.fn(),
    truncateTable: vi.fn(),
    dropColumn: vi.fn(),
    dropIndex: vi.fn(),
    getCreateSql: vi.fn(),
    analyzeTable: vi.fn(),
  },
}))

const { mockLoadColumns, mockInvalidateTable, schemaStoreState } = vi.hoisted(() => ({
  mockLoadColumns: vi.fn(),
  mockInvalidateTable: vi.fn(),
  schemaStoreState: { columns: {} as Record<string, unknown> },
}))

vi.mock('../../../store/schemaStore', () => ({
  useSchemaStore: (selector: (s: {
    columns: Record<string, unknown>
    loadColumns: unknown
    invalidateTable: unknown
  }) => unknown) => selector({
    ...schemaStoreState,
    loadColumns: mockLoadColumns,
    invalidateTable: mockInvalidateTable,
  }),
}))

const baseProps = {
  sessionId: 'session-1',
  database: 'app_db',
  table: 'users',
}

const tableInfo = {
  name: 'users',
  table_type: 'BASE TABLE',
  engine: 'InnoDB',
  row_count: 2,
  data_length: 16384,
  comment: '',
}

const longName = 'very_long_column_name_that_should_be_truncated_in_the_ui'
const longType = 'enum("pending","approved","rejected","flagged_for_manual_review")'
const longDefault = 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
const longComment = 'This is a deliberately long comment that should be clipped by the truncate utility and surfaced through the title attribute instead.'

const mockColumns = [
  {
    name: 'id',
    data_type: 'int',
    column_type: 'int',
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    is_auto_increment: true,
    extra: 'auto_increment',
    comment: '',
  },
  {
    name: longName,
    data_type: 'varchar',
    column_type: longType,
    is_nullable: true,
    column_default: longDefault,
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: longComment,
  },
  {
    name: 'status',
    data_type: 'varchar',
    column_type: 'varchar(20)',
    is_nullable: false,
    column_default: 'active',
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: 'record status',
  },
]

describe('TableSchemaView columns table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns)
    vi.mocked(api.getIndexes).mockResolvedValue([])
    vi.mocked(api.getTables).mockResolvedValue([tableInfo])
    vi.mocked(api.analyzeTable).mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
  })

  it('refreshes only statistics for the opened table, and shows forced results', async () => {
    const user = userEvent.setup()
    vi.mocked(api.analyzeTable).mockResolvedValue({
      ok: true,
      analyzed: true,
      row_count: 4242,
      data_length: 2048,
    })

    render(<TableSchemaView {...baseProps} />)

    // Opening the view asks the server for a throttled (non-forced) refresh.
    await waitFor(() =>
      expect(api.analyzeTable).toHaveBeenCalledWith('session-1', 'app_db', 'users', false),
    )

    await user.click(screen.getByRole('button', { name: /Refresh Stats/i }))

    expect(api.analyzeTable).toHaveBeenCalledWith('session-1', 'app_db', 'users', true)
    await waitFor(() => expect(screen.getByText('4,242')).toBeInTheDocument())
  })

  it('renders the # column header and 1-based row indices', async () => {
    render(<TableSchemaView {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument()
    })

    const columnsTable = screen.getByRole('columnheader', { name: '#' }).closest('table') as HTMLElement
    const rows = within(columnsTable)
      .getAllByRole('row')
      .filter(row => within(row).queryAllByRole('cell').length > 0)

    expect(rows).toHaveLength(mockColumns.length)
    expect(within(rows[0]).getByRole('cell', { name: '1' })).toBeInTheDocument()
    expect(within(rows[rows.length - 1]).getByRole('cell', { name: String(mockColumns.length) })).toBeInTheDocument()
  })

  it('truncates long values and exposes the full text via title', async () => {
    render(<TableSchemaView {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument()
    })

    const nameCell = screen.getByTitle(longName)
    expect(nameCell).toHaveClass('truncate')

    const typeCell = screen.getByTitle(longType)
    expect(typeCell).toHaveClass('truncate')

    const defaultCell = screen.getByTitle(longDefault)
    expect(defaultCell).toHaveClass('truncate')

    const commentCell = screen.getByTitle(longComment)
    expect(commentCell).toHaveClass('truncate')
  })

  it('pins #, Name, and action cells during horizontal scroll', async () => {
    render(<TableSchemaView {...baseProps} />)

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument()
    })

    const columnsTable = screen.getByRole('columnheader', { name: '#' }).closest('table') as HTMLElement

    const indexHeader = within(columnsTable).getByRole('columnheader', { name: '#' })
    expect(indexHeader).toHaveClass('sticky', 'left-0')

    const nameHeader = within(columnsTable).getByRole('columnheader', { name: 'Name' })
    expect(nameHeader).toHaveClass('sticky', 'left-10')

    const actionHeader = within(columnsTable).getAllByRole('columnheader').pop() as HTMLElement
    expect(actionHeader).toHaveClass('sticky', 'right-0')

    const rows = within(columnsTable)
      .getAllByRole('row')
      .filter(row => within(row).queryAllByRole('cell').length > 0)

    const firstRow = rows[0]
    const cells = within(firstRow).getAllByRole('cell')
    expect(cells[0]).toHaveClass('sticky', 'left-0')
    expect(cells[1]).toHaveClass('sticky', 'left-10')
    expect(cells[cells.length - 1]).toHaveClass('sticky', 'right-0')

    // Pinned body cells must use the project's named z-scale (no arbitrary
    // `z-[n]`) and must stay under the header: the `thead` is itself sticky with
    // `z-20`, so it is a stacking context and every header cell paints above the
    // body cells regardless of their own z-index. `z-raised` (10) still wins
    // against the static cells, which have no z-index.
    expect(columnsTable.querySelector('thead')).toHaveClass('sticky', 'z-20')
    expect(cells[0]).toHaveClass('z-raised')
    expect(cells[1]).toHaveClass('z-raised')
    expect(cells[cells.length - 1]).toHaveClass('z-raised')
  })
})

describe('TableSchemaView failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schemaStoreState.columns = {}
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns)
    vi.mocked(api.getIndexes).mockResolvedValue([])
    vi.mocked(api.getTables).mockResolvedValue([tableInfo])
    vi.mocked(api.analyzeTable).mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
  })

  it('surfaces a schema load failure instead of showing an empty tab', async () => {
    vi.mocked(api.getColumns).mockRejectedValue(new Error('Unknown table users'))

    render(<TableSchemaView {...baseProps} />)

    expect(await screen.findByText(/Error loading schema: Unknown table users/)).toBeInTheDocument()
  })

  it('stays silent when a superseded request is aborted', async () => {
    vi.mocked(api.getColumns).mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    render(<TableSchemaView {...baseProps} />)

    await waitFor(() => expect(api.getColumns).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Error loading schema/)).not.toBeInTheDocument())
  })

  it('stays silent when switching sessions aborts the in-flight load', async () => {
    // The request settles only once the caller aborts it, the way `fetch`
    // behaves — and the abort surfaces as a plain error here (browsers use an
    // `AbortError` DOMException, but a wrapper may rethrow anything), so the
    // reload must key off its own signal rather than the error's class.
    vi.mocked(api.getColumns).mockImplementation((_sessionId, _db, _table, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('The user aborted a request.')))
      }))

    const { rerender } = render(<TableSchemaView {...baseProps} />)
    await waitFor(() => expect(api.getColumns).toHaveBeenCalledTimes(1))

    rerender(<TableSchemaView {...baseProps} sessionId="session-2" />)

    // Cleanup aborted the first load; its rejection must be swallowed instead of
    // flashing "Error loading schema".
    await waitFor(() => expect(api.getColumns).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/Error loading schema/)).not.toBeInTheDocument())
  })

  it('surfaces a failed CREATE statement request instead of a dead Export button', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getCreateSql).mockRejectedValue(new Error('permission denied'))

    render(<TableSchemaView {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Schema/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Export Schema/i }))

    expect(await screen.findByText(/Error loading CREATE statement: permission denied/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /CREATE statement/i })).not.toBeInTheDocument()
  })

  it('renders the CREATE statement with SQL tokens highlighted', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getCreateSql).mockResolvedValue({
      create_sql: 'CREATE TABLE `users` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB',
    })

    render(<TableSchemaView {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Export Schema/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Export Schema/i }))

    const dialog = await screen.findByRole('dialog', { name: /CREATE statement/i })
    const code = dialog.querySelector('code') as HTMLElement
    await waitFor(() => expect(code.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0))
    const colors = [...code.querySelectorAll<HTMLElement>('span[style*="color"]')].map(span => span.style.color)
    expect(new Set(colors).size).toBeGreaterThan(1)
    expect(colors).toContain('rgb(198, 120, 221)')
    expect(code.textContent).toContain('DROP TABLE IF EXISTS `users`')
  })
})

describe('TableSchemaView primary key dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Warm column cache: the view then paints (and mounts the PK dialog) before
    // `indexes` resolves, which is exactly the state the missing reset needed —
    // the dialog is mounted once with `currentPkColumns === []`.
    schemaStoreState.columns = { 'session-1/app_db/users': mockColumns }
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns)
    vi.mocked(api.getIndexes).mockResolvedValue([
      { name: 'PRIMARY', columns: ['id'], is_unique: true, index_type: 'BTREE' },
    ])
    vi.mocked(api.getTables).mockResolvedValue([tableInfo])
    vi.mocked(api.analyzeTable).mockResolvedValue({
      ok: true,
      analyzed: false,
      row_count: tableInfo.row_count,
      data_length: tableInfo.data_length,
    })
  })

  it('preselects the existing primary key even though it arrives after mount', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Manage PK/i }))

    expect(screen.getByRole('button', { name: 'id' })).toHaveClass('bg-brand-600')
    expect(screen.getByRole('button', { name: 'status' })).not.toHaveClass('bg-brand-600')
  })

  it('discards an abandoned selection when the dialog is reopened', async () => {
    const user = userEvent.setup()
    render(<TableSchemaView {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Manage PK/i }))
    await user.click(screen.getByRole('button', { name: 'status' }))
    expect(screen.getByRole('button', { name: 'status' })).toHaveClass('bg-brand-600')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: /Manage PK/i }))

    expect(screen.getByRole('button', { name: 'id' })).toHaveClass('bg-brand-600')
    expect(screen.getByRole('button', { name: 'status' })).not.toHaveClass('bg-brand-600')
  })
})
