import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import TabContent from '../../components/editor/TabContent'
import ToastViewport from '../../components/ui/ToastViewport'
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

const grid = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
  scrollToTop: vi.fn(),
  clearSort: vi.fn(),
  deselectAll: vi.fn(),
  stopEditing: vi.fn(),
  getSelectedData: vi.fn(),
}))
const codeMirror = vi.hoisted(() => ({ props: null as null | Record<string, any> }))
const platform = vi.hoisted(() => ({ isMac: false }))
const motionMode = vi.hoisted(() => ({ reduce: false }))

vi.mock('../../utils/platform', () => ({
  get isMac() { return platform.isMac },
  get modKey() { return platform.isMac ? '⌘' : 'Ctrl' },
}))
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => motionMode.reduce,
}))

vi.mock('../../components/editor/ResultGrid', async () => {
  const React = await import('react')
  const MockResultGrid = React.forwardRef(function MockResultGrid(
    props: Record<string, any>,
    ref: React.ForwardedRef<unknown>,
  ) {
    grid.props = props
    React.useImperativeHandle(ref, () => ({
      scrollToTop: grid.scrollToTop,
      clearSort: grid.clearSort,
      deselectAll: grid.deselectAll,
      stopEditing: grid.stopEditing,
      getSelectedData: grid.getSelectedData,
      isAnyFilterPresent: () => false,
      getFilteredData: () => ({ columns: props.result.columns, rows: props.result.rows }),
    }))
    return React.createElement(
      'div',
      { 'data-testid': 'table-grid' },
      props.result.error ? `ERROR:${props.result.error}` : `${props.result.columns.join(',')}:${props.result.row_count}`,
    )
  })
  return { default: MockResultGrid }
})

vi.mock('../../components/table/TableSchemaView', async () => {
  const React = await import('react')
  return {
    default: function MockSchema(props: { refreshTrigger: number }) {
      return React.createElement('div', { 'data-testid': 'schema-view' }, `refresh ${props.refreshTrigger}`)
    },
  }
})

vi.mock('../../components/table/ExportDialog', async () => {
  const React = await import('react')
  return {
    default: function MockExport(props: Record<string, any>) {
      if (!props.open) return null
      return React.createElement(
        'div',
        { role: 'dialog', 'aria-label': 'Export data' },
        `${props.rowsOverrideLabel}:${props.rowsOverride?.rows.length ?? 0}`,
        React.createElement('button', { type: 'button', onClick: props.onClose }, 'Close data export'),
      )
    },
  }
})

vi.mock('../../components/table/ImportDialog', async () => {
  const React = await import('react')
  return {
    default: function MockImport(props: Record<string, any>) {
      if (!props.open) return null
      return React.createElement(
        'div',
        { role: 'dialog', 'aria-label': 'Import data' },
        React.createElement('button', { type: 'button', onClick: props.onImportComplete }, 'Complete import'),
        React.createElement('button', { type: 'button', onClick: props.onClose }, 'Close import'),
      )
    },
  }
})

vi.mock('../../components/editor/FilterHistoryDropdown', async () => {
  const React = await import('react')
  return {
    default: function MockHistory(props: { history: string[]; activeFilter?: string; onSelect: (v: string) => void }) {
      return React.createElement(
        'div',
        { 'data-testid': 'filter-history' },
        props.history.map(filter =>
          React.createElement(
            'button',
            {
              key: filter,
              type: 'button',
              'aria-current': filter === props.activeFilter ? 'true' : undefined,
              onClick: () => props.onSelect(filter),
            },
            `history:${filter}`,
          ),
        ),
      )
    },
  }
})

vi.mock('@uiw/react-codemirror', async () => {
  const React = await import('react')
  return {
    default: function MockCodeMirror(props: Record<string, any>) {
      codeMirror.props = props
      return React.createElement('textarea', {
        'aria-label': 'WHERE filter',
        value: props.value,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value),
      })
    },
  }
})

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    data_type: 'varchar',
    column_type: 'varchar(255)',
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: '',
    ...overrides,
  }
}

const columns: ColumnInfo[] = [
  column('id', { data_type: 'int', is_primary_key: true, is_nullable: false }),
  column('name'),
  column('price', { data_type: 'decimal', is_nullable: false }),
]

const tableResult: QueryResult = {
  columns: ['id', 'name', 'price'],
  rows: [[2, 'Bob', 2], [1, 'Alice', 3]],
  row_count: 2,
  exec_time_ms: 4,
}

const tableTab: Tab = {
  id: 't',
  label: 'users',
  type: 'table',
  sessionId: 's',
  database: 'app',
  table: 'users',
  dataState: { view: 'data', limit: 100 },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderTable(tab: Tab = tableTab) {
  return render(
    <>
      <TabContent tab={tab} />
      <ToastViewport />
    </>,
  )
}

async function waitForGrid() {
  await waitFor(() => expect(screen.getByTestId('table-grid')).toBeInTheDocument())
  return grid.props!
}

function filterExtensions(): unknown[] {
  return (codeMirror.props?.extensions ?? []) as unknown[]
}

function runFilterCommand(key: string): boolean | undefined {
  const state = EditorState.create({ doc: '', extensions: filterExtensions() as never[] })
  const binding = state.facet(keymap).flat().find(item => item.key === key)
  return binding?.run?.({} as never)
}

function filterCompletionResults(doc: string, explicit: boolean): CompletionResult[] {
  const state = EditorState.create({ doc, extensions: filterExtensions() as never[] })
  const context = new CompletionContext(state, doc.length, explicit)
  return state
    .languageDataAt<(ctx: CompletionContext) => CompletionResult | null>('autocomplete', doc.length)
    .map(provider => provider(context))
    .filter((result): result is CompletionResult => result !== null)
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  platform.isMac = false
  motionMode.reduce = false
  grid.props = null
  grid.scrollToTop.mockReset()
  grid.clearSort.mockReset()
  grid.deselectAll.mockReset()
  grid.stopEditing.mockReset()
  grid.getSelectedData.mockReset().mockReturnValue({ columns: tableResult.columns, rows: [tableResult.rows[0]] })
  api.executeQuery.mockResolvedValue(tableResult)
  api.getFunctions.mockResolvedValue([])
  api.killQueryExecution.mockResolvedValue({ ok: true })
  api.getTables.mockResolvedValue([])
  api.getColumns.mockResolvedValue([])
  api.getRowKey.mockResolvedValue({ columns: [], kind: null })
  api.rowUpdate.mockResolvedValue({
    ok: true,
    data: { ok: true, affected_rows: 1, sql_executed: 'UPDATE users SET name = \'Bobby\'' },
  })
  api.rowInsert.mockResolvedValue({
    ok: true,
    data: { ok: true, affected_rows: 1, sql_executed: 'INSERT INTO users VALUES (3)' },
  })
  api.rowDelete.mockResolvedValue({
    ok: true,
    data: { ok: true, affected_rows: 1, sql_executed: 'DELETE FROM users WHERE id = 2' },
  })
  useSchemaStore.setState({
    databases: { s: ['app'] },
    tables: {
      's/app': [{ name: 'users', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 2, data_length: 1, comment: '' }],
    },
    columns: { 's/app/users': columns },
    rowKeys: { 's/app/users': { columns: ['id'], kind: 'primary' } },
    loadingDbs: new Set(),
    loadingTables: new Set(),
    dbErrors: {},
  })
  useTabStore.setState({
    tabs: [tableTab],
    activeTabId: 't',
    pendingSqls: {},
  })
  useQueryLogStore.setState({ entries: [] })
})

describe('TableTab data loading and toolbar', () => {
  it('loads rows and drives search, filter, sorting, limits, refresh, and export', async () => {
    renderTable()
    const props = await waitForGrid()
    expect(api.executeQuery).toHaveBeenCalledWith(
      's',
      'SELECT * FROM `app`.`users` ORDER BY `id`',
      undefined,
      100,
      expect.any(AbortSignal),
      expect.any(String),
      't',
    )

    act(() => {
      props.onSortActiveChange(true)
    })
    const clearSort = screen.getByRole('button', { name: 'Clear Sort' })
    expect(clearSort).toBeEnabled()
    fireEvent.click(clearSort)
    expect(grid.clearSort).toHaveBeenCalledOnce()

    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    expect(screen.getByRole('button', { name: 'Clear column search' })).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).toContain("LIKE '%Ali%'"))

    fireEvent.change(search, { target: { value: 'Bob' } })
    act(() => {
      document.body.focus()
    })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const where = await screen.findByLabelText('WHERE filter')
    fireEvent.change(where, { target: { value: 'id = 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).toContain('WHERE (id = 1)'))
    expect(screen.getByRole('button', { name: 'Filtered' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle WHERE filter word wrap' }))
    expect(localStorage.getItem('lagun-data-filter-word-wrap')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'history:id = 1' }))
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).toContain('WHERE (id = 1)'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).not.toContain('WHERE'))

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.click(screen.getByRole('option', { name: '500' }))
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![3]).toBe(500))

    const callsBeforeRefresh = api.executeQuery.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() =>
      expect(api.executeQuery.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export data' })).toHaveTextContent('displayed rows:2')
    fireEvent.click(screen.getByRole('button', { name: 'Close data export' }))
  })

  it('manages column visibility, alphabetical sorting, and outside dismissal', async () => {
    renderTable()
    await waitForGrid()
    const columnsButton = screen.getByRole('button', { name: 'Columns' })
    fireEvent.click(columnsButton)
    const search = screen.getByPlaceholderText('Filter columns…')
    fireEvent.change(search, { target: { value: 'na' } })
    expect(screen.getByText('name')).toBeInTheDocument()
    expect(screen.queryByText('price')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'name' }))
    expect(screen.getByRole('button', { name: 'Columns (2/3)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'name' }))
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'name' }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Columns (0/3)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'All' }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Sort alphabetically' }))
    expect(screen.getByRole('checkbox', { name: 'Sort alphabetically' })).toBeChecked()
    fireEvent.mouseDown(screen.getByPlaceholderText('Filter columns…'))
    expect(screen.getByPlaceholderText('Filter columns…')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByPlaceholderText('Filter columns…')).not.toBeInTheDocument())
    fireEvent.click(columnsButton)
    fireEvent.keyDown(document, { key: 'x' })
    expect(screen.getByPlaceholderText('Filter columns…')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByPlaceholderText('Filter columns…')).not.toBeInTheDocument())
  })

  it('keeps the no-key note and offers selected-row and refresh paths', async () => {
    useSchemaStore.setState({ rowKeys: { 's/app/users': { columns: [], kind: null } } })
    renderTable()
    const props = await waitForGrid()
    expect(screen.getByRole('note')).toHaveTextContent(/every column/i)

    act(() => {
      props.onSelectionChange([{ id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' }])
    })
    expect(await screen.findByRole('button', { name: 'Delete 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export data' })).toHaveTextContent('selected rows:1')
    fireEvent.click(screen.getByRole('button', { name: 'Close data export' }))

    act(() => {
      grid.getSelectedData.mockReturnValue({ columns: ['id'], rows: [] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export data' })).toHaveTextContent('selected rows:1')
  })

  it('switches views, refreshes schema after a round trip, and runs import completion', async () => {
    const schemaTab: Tab = { ...tableTab, dataState: { view: 'schema' } }
    renderTable(schemaTab)
    expect(await screen.findByTestId('schema-view')).toHaveTextContent('refresh 0')
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Schema' }))
    expect(screen.getByTestId('schema-view')).toHaveTextContent('refresh 1')

    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('dialog', { name: 'Import data' })).toBeInTheDocument()
    const callsBefore = api.executeQuery.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Complete import' }))
    await waitFor(() => expect(api.executeQuery.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('renders an inactive table tab with its exit transition', async () => {
    render(<TabContent tab={tableTab} active={false} />)
    await waitForGrid()
    expect(screen.getByTestId('table-grid')).toBeInTheDocument()
  })

  it('returns early for a table tab with no database or table', async () => {
    renderTable({ ...tableTab, database: undefined, table: undefined })
    await act(async () => {})
    expect(api.executeQuery).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    await act(async () => {})
    expect(api.executeQuery).not.toHaveBeenCalled()
  })

  it('handles search Enter before a debounce timer and Escape with empty values', async () => {
    renderTable()
    await waitForGrid()
    const search = screen.getByLabelText('Search all columns')
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(search, { key: 'a' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(search).not.toHaveFocus()
  })

  it('applies filters from the CodeMirror keymap and dismisses them with Escape', async () => {
    api.getFunctions.mockResolvedValue(['MY_FUNC'])
    renderTable()
    await waitFor(() => expect(api.getFunctions).toHaveBeenCalled())
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const where = await screen.findByLabelText('WHERE filter')

    expect(runFilterCommand('Mod-Enter')).toBe(true)
    await waitFor(() => expect(useQueryLogStore.getState().entries[0].sql).not.toContain('WHERE'))

    fireEvent.change(where, { target: { value: 'id = 1' } })
    expect(runFilterCommand('Mod-Enter')).toBe(true)
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).toContain('WHERE (id = 1)'))
    expect(screen.getByRole('button', { name: 'Filtered' })).toBeInTheDocument()

    expect(runFilterCommand('Escape')).toBe(true)
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).not.toContain('WHERE'))

    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    document.getElementById('lagun-overlays')!.append(overlay)
    expect(runFilterCommand('Escape')).toBe(false)
    overlay.remove()
  })

  it('offers filter column and function completions', async () => {
    api.getFunctions.mockResolvedValue(['MY_FUNC'])
    renderTable()
    await waitForGrid()
    await waitFor(() => expect(api.getFunctions).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await screen.findByLabelText('WHERE filter')

    const implicitEmpty = filterCompletionResults('', false)
    expect(implicitEmpty).toEqual([])
    const explicit = filterCompletionResults('', true)
    const labels = explicit.flatMap(result => result.options.map(option => option.label))
    expect(labels).toEqual(expect.arrayContaining(['id', 'name', 'price', 'MY_FUNC', 'ABS']))
    const word = filterCompletionResults('na', false)
    expect(word.flatMap(result => result.options).some(option => option.label === 'name')).toBe(true)
  })

  it('clears an applied filter through the WHERE editor and handles IME search confirmation', async () => {
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const where = await screen.findByLabelText('WHERE filter')
    fireEvent.change(where, { target: { value: 'id = 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filtered' })).toBeInTheDocument())
    fireEvent.change(where, { target: { value: '' } })
    await waitFor(() => expect(api.executeQuery.mock.calls.at(-1)![1]).not.toContain('WHERE'))

    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    const calls = api.executeQuery.mock.calls.length
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(api.executeQuery.mock.calls.length).toBe(calls)
  })

  it('dismisses an empty filter bar without reloading', async () => {
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await screen.findByLabelText('WHERE filter')
    const calls = api.executeQuery.mock.calls.length
    expect(runFilterCommand('Escape')).toBe(true)
    await waitFor(() => expect(screen.queryByLabelText('WHERE filter')).not.toBeInTheDocument())
    expect(api.executeQuery.mock.calls.length).toBe(calls)
  })

  it('uses the platform keyboard hint for the filter bar', async () => {
    platform.isMac = true
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    expect(await screen.findByText('⌘↵')).toBeInTheDocument()
  })

  it('renders the staged-change bar without collapsed motion when reduced motion is preferred', async () => {
    motionMode.reduce = true
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(await screen.findByText('1 row staged')).toBeInTheDocument()
    const staged = screen.getByText('1 row staged').closest('.grid.shrink-0') as HTMLElement
    expect(staged).toBeInTheDocument()
    expect(staged).toHaveStyle({ gridTemplateRows: '1fr' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  })

  it('restores the persisted filter word-wrap preference and survives function metadata failure', async () => {
    localStorage.setItem('lagun-data-filter-word-wrap', 'false')
    api.getFunctions.mockRejectedValue(new Error('no functions'))
    renderTable()
    await waitForGrid()
    await waitFor(() => expect(api.getFunctions).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const toggle = await screen.findByRole('button', { name: 'Toggle WHERE filter word wrap' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', 'Enable WHERE filter word wrap')
    const completions = filterCompletionResults('', true)
    expect(completions.flatMap(result => result.options).some(option => option.label === 'MY_FUNC')).toBe(false)
  })

  it('debounces global search and focuses the column picker filter', async () => {
    renderTable()
    await waitForGrid()
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    await waitFor(
      () => expect(api.executeQuery.mock.calls.at(-1)![1]).toContain("LIKE '%Ali%'"),
      { timeout: 1200 },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
    const pickerSearch = screen.getByPlaceholderText('Filter columns…')
    await waitFor(() => expect(pickerSearch).toHaveFocus())
  })
})

describe('TableTab staged edits and writes', () => {
  it('stages, reverts, validates, duplicates, and clears changes with the toolbar', async () => {
    renderTable()
    const props = await waitForGrid()
    const row = { ...(props.rowData?.[0] ?? {}), id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-1' }

    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bobby', oldValue: 'Bob', data: row })
    })
    expect(await screen.findByRole('button', { name: 'Apply (1)' })).toBeInTheDocument()

    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bob', oldValue: 'Bobby', data: row })
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Apply \(/ })).not.toBeInTheDocument())

    act(() => {
      props.onCellEdit({ column: 'price', newValue: '', oldValue: 2, data: row })
    })
    expect(await screen.findByText(/price cannot be empty/)).toBeInTheDocument()

    act(() => {
      props.onDuplicateRow(row, 'withoutKeys')
    })
    expect(await screen.findByText(/Duplicated row without keys/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply (1)' })).toBeInTheDocument()

    act(() => {
      props.onDuplicateRow(row, 'withKeys')
    })
    expect(await screen.findByText(/Duplicated row with keys/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply (2)' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Apply \(/ })).not.toBeInTheDocument())
  })

  it('tracks multiple changes on one row and removes only reverted columns', async () => {
    renderTable()
    const props = await waitForGrid()
    const row = { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-1' }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bobby', oldValue: 'Bob', data: row })
    })
    act(() => {
      props.onCellEdit({ column: 'price', newValue: 5, oldValue: 2, data: row })
    })
    expect(await screen.findByRole('button', { name: 'Apply (1)' })).toBeInTheDocument()

    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bob', oldValue: 'Bobby', data: row })
    })
    expect(screen.getByRole('button', { name: 'Apply (1)' })).toBeInTheDocument()
    act(() => {
      props.onCellEdit({ column: 'price', newValue: 2, oldValue: 5, data: row })
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Apply \(/ })).not.toBeInTheDocument())
  })

  it('does not stage cell edits while a refresh is in flight', async () => {
    const refresh = deferred<QueryResult>()
    api.executeQuery
      .mockResolvedValueOnce(tableResult)
      .mockReturnValueOnce(refresh.promise)
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refreshing data' })).toBeInTheDocument())
    act(() => {
      grid.props!.onCellEdit({
        column: 'name',
        newValue: 'Bobby',
        oldValue: 'Bob',
        data: { id: 2, name: 'Bob', __ag_rowId: 'row-1' },
      })
    })
    expect(screen.queryByRole('button', { name: /Apply \(/ })).not.toBeInTheDocument()
    await act(async () => {
      refresh.resolve(tableResult)
    })
  })

  it('changes the limit without reloading when no result is loaded yet', async () => {
    const pending = deferred<QueryResult>()
    api.executeQuery.mockReturnValue(pending.promise)
    renderTable()
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.click(screen.getByRole('option', { name: '500' }))
    expect(api.executeQuery).toHaveBeenCalledOnce()
    await act(async () => {
      pending.resolve(tableResult)
    })
  })

  it('applies a combined update and insert, then reports success', async () => {
    renderTable()
    const props = await waitForGrid()
    const row = { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-1' }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bobby', oldValue: 'Bob', data: row })
      props.onCellEdit({
        column: 'name',
        newValue: 'Carol',
        oldValue: 'Bob',
        data: { name: 'Carol', __ag_rowId: 'draft-1', __lagun_insertDraft: true },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (2)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Review Staged Changes' })
    expect(within(dialog).getByText('name')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Updated 1 row and inserted 1 row.')).toBeInTheDocument()
    expect(api.rowUpdate).toHaveBeenCalledOnce()
    expect(api.rowInsert).toHaveBeenCalledOnce()
  })

  it('keeps failed row updates staged for retry', async () => {
    api.rowUpdate
      .mockResolvedValueOnce({ ok: true, data: { ok: true, affected_rows: 0 } })
      .mockResolvedValueOnce({ ok: true, data: { ok: false, error: 'rejected' } })
      .mockResolvedValueOnce({ ok: false, error: 'transport down' })
    renderTable()
    const props = await waitForGrid()
    const row = { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-1' }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bobby', oldValue: 'Bob', data: row })
    })

    for (const expected of ['Update matched 0 rows', 'rejected', 'transport down']) {
      fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
      expect(await screen.findByText(new RegExp(expected))).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply (1)' })).toBeInTheDocument()
    }
  })

  it('uses the generic update failure text and leaves a restaged edit in place', async () => {
    const update = deferred<{ ok: boolean; data: { ok: boolean; affected_rows: number; error?: string } }>()
    api.rowUpdate.mockReturnValueOnce(update.promise)
    renderTable()
    const props = await waitForGrid()
    const first = { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-1' }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'Bobby', oldValue: 'Bob', data: first })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    await waitFor(() => expect(api.rowUpdate).toHaveBeenCalledOnce())

    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'Robert',
        oldValue: 'Bob',
        data: { ...first, __ag_rowId: 'row-2' },
      })
    })
    await act(async () => {
      update.resolve({ ok: true, data: { ok: false, affected_rows: 0 } })
    })
    expect(await screen.findByText('Update failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply (2)' })).toBeInTheDocument()
  })

  it('reports insert failures and reloads the data', async () => {
    api.rowInsert
      .mockResolvedValueOnce({ ok: true, data: { ok: false, error: 'insert rejected' } })
      .mockResolvedValueOnce({ ok: false, error: 'insert transport' })
    renderTable()
    const props = await waitForGrid()
    const draft = { name: 'New', __ag_rowId: 'draft-1', __lagun_insertDraft: true }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'New', oldValue: null, data: draft })
    })

    for (const expected of ['insert rejected', 'insert transport']) {
      fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
      expect(await screen.findByText(new RegExp(expected))).toBeInTheDocument()
    }
    expect(api.executeQuery.mock.calls.length).toBeGreaterThan(1)
  })

  it('rejects a duplicated draft whose numeric value is blank before any write', async () => {
    api.executeQuery.mockResolvedValueOnce({
      ...tableResult,
      rows: [[2, 'Bob', ''], [1, 'Alice', 3]],
    })
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onDuplicateRow(
        { id: 2, name: 'Bob', price: '', __ag_rowId: 'row-2' },
        'withKeys',
      )
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText(/price cannot be empty/)).toBeInTheDocument()
    expect(api.rowInsert).not.toHaveBeenCalled()
  })

  it('uses the generic insert failure text and plural success messages', async () => {
    api.rowInsert.mockResolvedValueOnce({ ok: true, data: { ok: false, affected_rows: 0 } })
    renderTable()
    const props = await waitForGrid()
    const draft = { name: 'New', __ag_rowId: 'draft-1', __lagun_insertDraft: true }
    act(() => {
      props.onCellEdit({ column: 'name', newValue: 'New', oldValue: null, data: draft })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Insert failed')).toBeInTheDocument()
  })

  it('reports plural update and insert success messages independently', async () => {
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'A',
        oldValue: 'Bob',
        data: { id: 1, name: 'Alice', __ag_rowId: 'a' },
      })
      props.onCellEdit({
        column: 'name',
        newValue: 'B',
        oldValue: 'Bob',
        data: { id: 2, name: 'Bob', __ag_rowId: 'b' },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (2)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Updated 2 rows.')).toBeInTheDocument()
  })

  it('reports a combined plural update and insert success message', async () => {
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'A',
        oldValue: 'Bob',
        data: { id: 1, name: 'Alice', __ag_rowId: 'a' },
      })
      props.onCellEdit({
        column: 'name',
        newValue: 'B',
        oldValue: 'Bob',
        data: { id: 2, name: 'Bob', __ag_rowId: 'b' },
      })
      props.onCellEdit({
        column: 'name',
        newValue: 'C',
        oldValue: null,
        data: { name: 'C', __ag_rowId: 'd1', __lagun_insertDraft: true },
      })
      props.onCellEdit({
        column: 'name',
        newValue: 'D',
        oldValue: null,
        data: { name: 'D', __ag_rowId: 'd2', __lagun_insertDraft: true },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (4)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Updated 2 rows and inserted 2 rows.')).toBeInTheDocument()
  })

  it('reports singular and plural insert-only success messages', async () => {
    const first = renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'One',
        oldValue: null,
        data: { name: 'One', __ag_rowId: 'd1', __lagun_insertDraft: true },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Inserted 1 row.')).toBeInTheDocument()
    first.unmount()
    renderTable({ ...tableTab, id: 't2' })
    const nextProps = await waitForGrid()
    act(() => {
      nextProps.onCellEdit({
        column: 'name',
        newValue: 'One',
        oldValue: null,
        data: { name: 'One', __ag_rowId: 'd1', __lagun_insertDraft: true },
      })
      nextProps.onCellEdit({
        column: 'name',
        newValue: 'Two',
        oldValue: null,
        data: { name: 'Two', __ag_rowId: 'd2', __lagun_insertDraft: true },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (2)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))
    expect(await screen.findByText('Inserted 2 rows.')).toBeInTheDocument()
  })

  it('handles delete rejection, zero matches, and transport errors', async () => {
    api.rowDelete
      .mockResolvedValueOnce({ ok: false, error: 'delete down' })
      .mockResolvedValueOnce({ ok: true, data: { ok: false, error: 'delete rejected' } })
      .mockResolvedValueOnce({ ok: true, data: { ok: true, affected_rows: 0 } })
    renderTable()
    const props = await waitForGrid()

    for (const expected of ['delete down', 'delete rejected', 'Delete matched 0 rows']) {
      act(() => {
        props.onSelectionChange([{ id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' }])
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }))
      expect(await screen.findByRole('alertdialog', { name: 'Delete Row' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Delete Row' }))
      expect(await screen.findByText(new RegExp(expected))).toBeInTheDocument()
    }
  })

  it('uses the generic delete failure text and plural success text', async () => {
    api.rowDelete
      .mockResolvedValueOnce({ ok: true, data: { ok: false, affected_rows: 0 } })
      .mockResolvedValueOnce({ ok: true, data: { ok: true, affected_rows: 2, sql_executed: '' } })
    renderTable()
    const props = await waitForGrid()

    act(() => {
      props.onSelectionChange([{ id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' }])
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Row' }))
    expect(await screen.findByText('Delete failed')).toBeInTheDocument()

    act(() => {
      props.onSelectionChange([
        { id: 1, name: 'Alice', __ag_rowId: 'a' },
        { id: 2, name: 'Bob', __ag_rowId: 'b' },
      ])
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Rows' }))
    expect(await screen.findByText('Deleted 2 rows.')).toBeInTheDocument()
  })

  it('clears draft status messages after their display window', async () => {
    renderTable()
    await waitForGrid()
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
      expect(screen.getByText(/Inserted empty row draft/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(screen.queryByText(/Inserted empty row draft/)).not.toBeInTheDocument()

      act(() => {
        grid.props!.onDuplicateRow(
          { id: 2, name: 'Bob', __ag_rowId: 'row-2' },
          'withKeys',
        )
      })
      expect(screen.getByText(/Duplicated row with keys/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(screen.queryByText(/Duplicated row with keys/)).not.toBeInTheDocument()

      act(() => {
        grid.props!.onCellEdit({
          column: 'price',
          newValue: '',
          oldValue: 2,
          data: { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' },
        })
      })
      expect(screen.getByText(/price cannot be empty/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(screen.queryByText(/price cannot be empty/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirms multiple-row deletion and disables deletion for insert-draft selections', async () => {
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onSelectionChange([
        { id: 1, name: 'Alice', __ag_rowId: 'a' },
        { id: 2, name: 'Bob', __ag_rowId: 'b' },
      ])
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2' }))
    expect(await screen.findByRole('alertdialog', { name: 'Delete Rows' })).toHaveTextContent('Delete 2 rows permanently')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Rows' }))
    await waitFor(() => expect(api.rowDelete).toHaveBeenCalledOnce())

    act(() => {
      props.onSelectionChange([
        { __lagun_insertDraft: true, __ag_rowId: 'draft' },
      ])
    })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('cancels delete and staged-change review dialogs without writing', async () => {
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onSelectionChange([{ id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' }])
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Delete Row' })).not.toBeInTheDocument())
    expect(api.rowDelete).not.toHaveBeenCalled()

    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'Bobby',
        oldValue: 'Bob',
        data: { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review Staged Changes' })).not.toBeInTheDocument())
    expect(api.rowUpdate).not.toHaveBeenCalled()
  })

  it('closes the staged-change review from the modal close button', async () => {
    renderTable()
    const props = await waitForGrid()
    act(() => {
      props.onCellEdit({
        column: 'name',
        newValue: 'Bobby',
        oldValue: 'Bob',
        data: { id: 2, name: 'Bob', price: 2, __ag_rowId: 'row-2' },
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Review Staged Changes' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review Staged Changes' })).not.toBeInTheDocument())
  })
})

describe('TableTab loading failures and cancellation', () => {
  it('reports initial and refresh failures while retaining the old result', async () => {
    api.executeQuery.mockRejectedValueOnce(new Error('network down'))
    const first = renderTable()
    expect(await screen.findByText(/Could not load data\. network down/)).toBeInTheDocument()
    first.unmount()

    api.executeQuery.mockResolvedValueOnce(tableResult).mockRejectedValueOnce(new Error('refresh down'))
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    expect(await screen.findByText(/Refresh failed; showing previous result\. refresh down/)).toBeInTheDocument()
    expect(screen.getByTestId('table-grid')).toHaveTextContent('id,name,price:2')
  })

  it('keeps response timings and tolerates missing count/timing fields on an error result', async () => {
    api.executeQuery
      .mockResolvedValueOnce({
        ...tableResult,
        timings: {
          pool_wait_ms: 1,
          setup_ms: 1,
          execute_ms: 1,
          fetch_ms: 1,
          value_serialize_ms: 1,
          total_ms: 5,
        },
      })
      .mockResolvedValueOnce({
        columns: [],
        rows: [],
        row_count: undefined as never,
        exec_time_ms: undefined as never,
        error: 'bad shape',
      })
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    expect(await screen.findByText(/Refresh failed; showing previous result\. bad shape/)).toBeInTheDocument()
    expect(useQueryLogStore.getState().entries[0].rowCount).toBeUndefined()
  })

  it('keeps the previous result when a refresh returns an error payload', async () => {
    api.executeQuery
      .mockResolvedValueOnce(tableResult)
      .mockResolvedValueOnce({ ...tableResult, rows: [], row_count: 0, error: 'boom' })
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    expect(await screen.findByText(/Refresh failed; showing previous result\. boom/)).toBeInTheDocument()
    expect(screen.getByTestId('table-grid')).toHaveTextContent('id,name,price:2')
  })

  it('shows an initial query error payload and avoids committing a failed filter', async () => {
    api.executeQuery
      .mockResolvedValueOnce(tableResult)
      .mockResolvedValueOnce({ ...tableResult, error: 'filter failed' })
    renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    fireEvent.change(await screen.findByLabelText('WHERE filter'), { target: { value: 'id = 99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText(/Refresh failed; showing previous result\. filter failed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filtered' })).not.toBeInTheDocument()

    api.executeQuery.mockResolvedValueOnce({ ...tableResult, error: 'bad initial' })
    const view = renderTable()
    await waitFor(() => expect(screen.getAllByTestId('table-grid').at(-1)).toHaveTextContent('ERROR:bad initial'))
    view.unmount()
  })

  it('reports missing column metadata and silently handles an aborted initial load', async () => {
    useSchemaStore.setState({ columns: { 's/app/users': [] } })
    const first = renderTable()
    expect(await screen.findByText(/Could not load data\. Could not load table columns/)).toBeInTheDocument()
    first.unmount()

    useSchemaStore.setState({ columns: { 's/app/users': columns } })
    api.executeQuery.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const second = renderTable()
    await act(async () => {})
    expect(screen.queryByTestId('table-grid')).not.toBeInTheDocument()
    expect(screen.queryByText(/Could not load data/)).not.toBeInTheDocument()
    second.unmount()
  })

  it('cancels the previous execution when two loads overlap and on unmount', async () => {
    const firstLoad = deferred<QueryResult>()
    api.executeQuery.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(tableResult)
    const view = renderTable()
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledOnce())
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(api.killQueryExecution).toHaveBeenCalledOnce())
    await waitForGrid()
    act(() => {
      firstLoad.resolve({ ...tableResult, row_count: 99 })
    })

    const pending = deferred<QueryResult>()
    api.executeQuery.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledTimes(3))
    view.unmount()
    await waitFor(() => expect(api.killQueryExecution).toHaveBeenCalledTimes(2))
  })

  it('scrolls a filtered result back to the top after it renders', async () => {
    api.executeQuery
      .mockResolvedValueOnce(tableResult)
      .mockResolvedValueOnce({ ...tableResult, row_count: 1 })
    renderTable()
    await waitForGrid()
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(grid.scrollToTop).toHaveBeenCalled())
  })

  it('opens export and import dialogs, closes them, and keeps their lazy mounts when table props disappear', async () => {
    const { rerender } = renderTable()
    await waitForGrid()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export data' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close data export' }))

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('dialog', { name: 'Import data' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close import' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import data' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export data' })).toBeInTheDocument()
    rerender(<TabContent tab={{ ...tableTab, database: undefined, table: undefined }} />)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Export data' })).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Import data' })).not.toBeInTheDocument()
    })
  })

  it('continues after a failed targeted kill when loads overlap', async () => {
    api.killQueryExecution.mockRejectedValueOnce(new Error('kill failed'))
    const first = deferred<QueryResult>()
    api.executeQuery.mockReturnValueOnce(first.promise).mockResolvedValueOnce(tableResult)
    renderTable()
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledOnce())
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitForGrid()
    act(() => {
      first.resolve(tableResult)
    })
  })

  it('drops an intermediate load whose cancellation is superseded by a newer load', async () => {
    const kill = deferred<{ ok: boolean }>()
    api.killQueryExecution.mockReturnValueOnce(kill.promise)
    const first = deferred<QueryResult>()
    api.executeQuery.mockReturnValueOnce(first.promise).mockResolvedValueOnce(tableResult)
    renderTable()
    await waitFor(() => expect(api.executeQuery).toHaveBeenCalledOnce())
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.change(search, { target: { value: 'Alice' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await act(async () => {
      kill.resolve({ ok: true })
    })
    await waitForGrid()
    expect(api.executeQuery).toHaveBeenCalledTimes(2)
    act(() => {
      first.resolve(tableResult)
    })
  })

  it('drops stale metadata from an older load', async () => {
    const columnsDeferred = deferred<typeof columns>()
    useSchemaStore.setState({ columns: {} })
    api.getColumns.mockReturnValueOnce(columnsDeferred.promise)
    renderTable()
    await waitFor(() => expect(api.getColumns).toHaveBeenCalledOnce())
    const search = screen.getByLabelText('Search all columns')
    fireEvent.change(search, { target: { value: 'Ali' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await act(async () => {
      columnsDeferred.resolve(columns)
    })
    await waitForGrid()
    expect(api.getColumns).toHaveBeenCalledOnce()
  })
})
