import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  },
}))

vi.mock('../../../store/schemaStore', () => ({
  useSchemaStore: () => ({
    columns: {},
    loadColumns: vi.fn(),
    invalidateTable: vi.fn(),
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
    vi.mocked(api.getColumns).mockResolvedValue(mockColumns)
    vi.mocked(api.getIndexes).mockResolvedValue([])
    vi.mocked(api.getTables).mockResolvedValue([tableInfo])
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
  })
})
