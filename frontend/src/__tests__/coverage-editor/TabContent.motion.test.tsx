import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TabContent from '../../components/editor/TabContent'
import { useSchemaStore } from '../../store/schemaStore'
import { useTabStore } from '../../store/tabStore'
import { useQueryLogStore } from '../../store/queryLogStore'
import type { ColumnInfo, QueryResult, Tab } from '../../types'

const api = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  getFunctions: vi.fn(),
  killQueryExecution: vi.fn(),
  rowUpdate: vi.fn(),
  rowInsert: vi.fn(),
  rowDelete: vi.fn(),
  getTables: vi.fn(),
  getColumns: vi.fn(),
  getRowKey: vi.fn(),
  getDatabases: vi.fn(),
  getTablesBatch: vi.fn(),
}))
vi.mock('../../api/client', () => ({ api }))

vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children: any }) => children,
}))

vi.mock('motion/react-m', async () => {
  const React = await import('react')
  const make = (tag: string) => React.forwardRef(function MotionMock(
    props: Record<string, any>,
    ref: React.ForwardedRef<HTMLElement>,
  ) {
    const {
      initial,
      animate,
      exit,
      transition,
      variants,
      whileHover,
      whileTap,
      layoutId,
      onAnimationStart,
      onAnimationComplete,
      ...domProps
    } = props
    void initial
    void animate
    void exit
    void transition
    void variants
    void whileHover
    void whileTap
    void layoutId
    onAnimationStart?.()
    React.useEffect(() => {
      onAnimationStart?.('open')
      onAnimationComplete?.()
      onAnimationStart?.('closed')
      // The mock intentionally reports the lifecycle callbacks once per mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return React.createElement(tag, { ref, ...domProps })
  })
  return { div: make('div'), span: make('span'), button: make('button') }
})

const grid = vi.hoisted(() => ({ props: null as null | Record<string, any> }))
vi.mock('../../components/editor/ResultGrid', async () => {
  const React = await import('react')
  const Mock = React.forwardRef(function MockResultGrid(
    props: Record<string, any>,
    ref: React.ForwardedRef<unknown>,
  ) {
    grid.props = props
    React.useImperativeHandle(ref, () => ({
      scrollToTop: vi.fn(),
      clearSort: vi.fn(),
      deselectAll: vi.fn(),
      stopEditing: vi.fn(),
      getSelectedData: () => ({ columns: props.result.columns, rows: [] }),
      isAnyFilterPresent: () => false,
      getFilteredData: () => ({ columns: props.result.columns, rows: props.result.rows }),
    }))
    return React.createElement('div', { 'data-testid': 'motion-grid' })
  })
  return { default: Mock }
})

vi.mock('../../components/table/TableSchemaView', async () => {
  const React = await import('react')
  return { default: () => React.createElement('div', { 'data-testid': 'motion-schema' }) }
})
vi.mock('../../components/table/ExportDialog', async () => {
  const React = await import('react')
  return { default: () => React.createElement('div') }
})
vi.mock('../../components/table/ImportDialog', async () => {
  const React = await import('react')
  return { default: () => React.createElement('div') }
})
vi.mock('../../components/editor/FilterHistoryDropdown', async () => {
  const React = await import('react')
  return { default: () => React.createElement('div') }
})
vi.mock('@uiw/react-codemirror', async () => {
  const React = await import('react')
  return {
    default: (props: Record<string, any>) =>
      React.createElement('textarea', {
        'aria-label': 'WHERE filter',
        value: props.value,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value),
      }),
  }
})

const columns: ColumnInfo[] = [
  {
    name: 'id',
    data_type: 'int',
    column_type: 'int',
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    is_auto_increment: true,
    extra: '',
    comment: '',
  },
  {
    name: 'name',
    data_type: 'varchar',
    column_type: 'varchar(255)',
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: '',
  },
]

const result: QueryResult = {
  columns: ['id', 'name'],
  rows: [[1, 'Alice']],
  row_count: 1,
  exec_time_ms: 1,
}

const tab: Tab = {
  id: 'motion-table',
  label: 'users',
  type: 'table',
  sessionId: 's',
  database: 'app',
  table: 'users',
  dataState: { view: 'data' },
}

describe('TableTab motion callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.executeQuery.mockResolvedValue(result)
    api.getFunctions.mockResolvedValue([])
    api.getTables.mockResolvedValue([])
    api.getColumns.mockResolvedValue(columns)
    api.getRowKey.mockResolvedValue({ columns: ['id'], kind: 'primary' })
    api.killQueryExecution.mockResolvedValue({ ok: true })
    useSchemaStore.setState({
      databases: { s: ['app'] },
      tables: {
        's/app': [{ name: 'users', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 1, data_length: 1, comment: '' }],
      },
      columns: { 's/app/users': columns },
      rowKeys: { 's/app/users': { columns: ['id'], kind: 'primary' } },
      loadingDbs: new Set(),
      loadingTables: new Set(),
      dbErrors: {},
    })
    useTabStore.setState({ tabs: [tab], activeTabId: tab.id, pendingSqls: {} })
    useQueryLogStore.setState({ entries: [] })
  })

  it('runs panel and staged-bar animation callbacks, including reduced motion', async () => {
    const { container } = render(<TabContent tab={tab} />)
    await waitFor(() => expect(screen.getByTestId('motion-grid')).toBeInTheDocument())
    const panels = container.querySelectorAll('.lagun-view-panel')
    expect(panels.length).toBeGreaterThan(0)

    expect(panels[panels.length - 1]).toHaveClass('pointer-events-auto')
    fireEvent.click(screen.getByRole('button', { name: 'Schema' }))
    await waitFor(() => expect(screen.getByTestId('motion-schema')).toBeInTheDocument())
    expect(container.querySelectorAll('.lagun-view-panel').length).toBeGreaterThanOrEqual(2)

    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await waitFor(() => expect(screen.getByTestId('motion-grid')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(await screen.findByText('1 row staged')).toBeInTheDocument()
  })
})
