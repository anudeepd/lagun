import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TabContent from '../../components/editor/TabContent'
import { useSchemaStore } from '../../store/schemaStore'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import { useQueryLogStore } from '../../store/queryLogStore'
import type { QueryResult, SequentialScriptResult, Session, Tab } from '../../types'

const api = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  executeSequentialScriptQuery: vi.fn(),
  validateScriptQuery: vi.fn(),
  executeScriptQuery: vi.fn(),
  killQuery: vi.fn(),
  killScriptQuery: vi.fn(),
  killQueryExecution: vi.fn(),
  getFunctions: vi.fn(),
  getDatabases: vi.fn(),
  getTables: vi.fn(),
  getColumns: vi.fn(),
  getRowKey: vi.fn(),
  getTablesBatch: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api }))

const editor = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
  selection: '',
}))
const platform = vi.hoisted(() => ({ isMac: false }))
const bulkSummary = vi.hoisted(() => ({ props: null as null | Record<string, any> }))

vi.mock('../../utils/platform', () => ({
  get isMac() { return platform.isMac },
  get modKey() { return platform.isMac ? '⌘' : 'Ctrl' },
}))

vi.mock('../../components/editor/QueryEditor', async () => {
  const React = await import('react')
  return {
    default: function MockQueryEditor(props: Record<string, any>) {
      editor.props = props
      const view = {
        state: {
          selection: { main: { from: 0, to: editor.selection.length } },
          sliceDoc: () => editor.selection,
        },
        requestMeasure: vi.fn(),
      }
      if (props.editorRef) props.editorRef.current = { view }
      return React.createElement(
        'div',
        null,
        React.createElement('textarea', {
          'aria-label': 'SQL editor',
          value: props.value,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value),
        }),
        React.createElement('button', { type: 'button', onClick: props.onRun }, 'Run'),
        props.running
          ? React.createElement('button', { type: 'button', onClick: props.onCancel }, 'Cancel query')
          : null,
      )
    },
  }
})

const grid = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
  clearSort: vi.fn(),
  isAnyFilterPresent: vi.fn(() => false),
  getFilteredData: vi.fn(() => ({ columns: [], rows: [] })),
}))

vi.mock('../../components/editor/ResultGrid', async () => {
  const React = await import('react')
  const MockResultGrid = React.forwardRef(function MockResultGrid(
    props: Record<string, any>,
    ref: React.ForwardedRef<unknown>,
  ) {
    grid.props = props
    React.useImperativeHandle(ref, () => ({
      clearSort: grid.clearSort,
      isAnyFilterPresent: grid.isAnyFilterPresent,
      getFilteredData: grid.getFilteredData,
    }))
    return React.createElement(
      'div',
      { 'data-testid': 'result-grid' },
      props.result.error ? `ERROR:${props.result.error}` : `${props.result.columns.join(',')}:${props.result.row_count}`,
    )
  })
  return { default: MockResultGrid }
})

vi.mock('../../components/editor/BulkResultSummary', async () => {
  const React = await import('react')
  return {
    default: function MockBulkSummary({ result }: { result: { error?: { code: string; cause?: string } | null } }) {
      bulkSummary.props = result
      return React.createElement('div', { 'data-testid': 'bulk-summary' }, result.error?.code ?? 'committed')
    },
  }
})

vi.mock('../../components/editor/BulkConfirmDialog', async () => {
  const React = await import('react')
  return {
    default: function MockBulkConfirm(props: Record<string, any>) {
      if (!props.open) return null
      return React.createElement(
        'div',
        { role: 'dialog', 'aria-label': 'Review bulk write' },
        React.createElement('button', { type: 'button', onClick: props.onConfirm }, 'Confirm bulk'),
        React.createElement('button', { type: 'button', onClick: props.onClose }, 'Cancel bulk'),
      )
    },
  }
})

vi.mock('../../components/table/ExportDialog', async () => {
  const React = await import('react')
  return {
    default: function MockExportDialog(props: Record<string, any>) {
      if (!props.open) return null
      return React.createElement(
        'div',
        { role: 'dialog', 'aria-label': 'Export result' },
        `Export rows ${props.rowsOverride?.rows.length ?? 0}`,
        React.createElement('button', { type: 'button', onClick: props.onClose }, 'Close export'),
      )
    },
  }
})

const session: Session = {
  id: 's',
  name: 'Session',
  host: 'localhost',
  port: 3306,
  username: 'root',
  default_db: null,
  query_limit: 100,
  ssl_enabled: false,
  selected_databases: [],
  created_at: '',
  updated_at: '',
}

const queryTab: Tab = {
  id: 'q',
  label: 'Query',
  type: 'query',
  sessionId: 's',
  database: 'app',
}

const result: QueryResult = {
  columns: ['id', 'name'],
  rows: [[1, 'Alice']],
  row_count: 1,
  exec_time_ms: 3,
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

function renderQuery(tab: Tab = queryTab) {
  return render(<TabContent tab={tab} />)
}

async function setSql(value: string) {
  fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value } })
  await act(async () => {})
}

async function run_query() {
  fireEvent.click(screen.getByRole('button', { name: 'Run' }))
  await act(async () => {})
}

beforeEach(() => {
  vi.resetAllMocks()
  platform.isMac = false
  bulkSummary.props = null
  editor.selection = ''
  grid.props = null
  localStorage.clear()
  api.getFunctions.mockResolvedValue([])
  api.getDatabases.mockResolvedValue([])
  api.getTables.mockResolvedValue([])
  api.getColumns.mockResolvedValue([])
  api.getRowKey.mockResolvedValue({ columns: [], kind: null })
  api.killQuery.mockResolvedValue({ ok: true, data: { ok: true } })
  api.killScriptQuery.mockResolvedValue({ ok: true, data: { ok: true } })
  api.killQueryExecution.mockResolvedValue({ ok: true, data: { ok: true } })
  api.executeQuery.mockResolvedValue(result)
  grid.clearSort.mockReset()
  grid.isAnyFilterPresent.mockReset().mockReturnValue(false)
  grid.getFilteredData.mockReset().mockReturnValue({ columns: [], rows: [] })
  useSchemaStore.setState({
    databases: { s: ['app', 'analytics'] },
    tables: { 's/app': [], 's/analytics': [] },
    columns: {},
    rowKeys: {},
    loadingDbs: new Set(),
    loadingTables: new Set(),
    dbErrors: {},
  })
  useSessionStore.setState({ sessions: [session], activeSessionId: 's' })
  useTabStore.setState({
    tabs: [{ ...queryTab, sql: 'SELECT 1' }],
    activeTabId: 'q',
    pendingSqls: {},
  })
  useQueryLogStore.setState({ entries: [] })
})

describe('QueryTab execution', () => {
  it('runs a single statement, renders its result, exports, and clears sorting', async () => {
    renderQuery()
    expect(screen.getByText(/Press .*Enter to run a query/)).toBeInTheDocument()
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent('id,name:1')
    expect(api.executeQuery).toHaveBeenCalledWith(
      's',
      'SELECT 1',
      'app',
      1000,
      expect.any(AbortSignal),
      expect.stringMatching(/-0$/),
      'q',
    )

    const clearSort = screen.getByRole('button', { name: 'Clear Sort' })
    expect(clearSort).toBeDisabled()
    act(() => {
      grid.props?.onSortActiveChange?.(true)
    })
    expect(clearSort).toBeEnabled()
    fireEvent.click(clearSort)
    expect(grid.clearSort).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export result' })).toHaveTextContent('Export rows 1')
    fireEvent.click(screen.getByRole('button', { name: 'Close export' }))

    expect(useQueryLogStore.getState().entries[0]).toMatchObject({
      sql: 'SELECT 1',
      sessionId: 's',
      database: 'app',
    })
  })

  it('uses a selected statement and shows query errors without export controls', async () => {
    api.executeQuery.mockResolvedValue({ ...result, error: 'boom' })
    renderQuery()
    editor.selection = 'SELECT 2'
    await setSql('SELECT 1;\nSELECT 2')
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent('ERROR:boom')
    expect(api.executeQuery).toHaveBeenCalledWith(
      's',
      'SELECT 2',
      'app',
      1000,
      expect.any(AbortSignal),
      expect.any(String),
      'q',
    )
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument()
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('stops a single statement on abort and logs the cancelled attempt', async () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    api.executeQuery.mockRejectedValue(aborted)
    renderQuery()
    await run_query()
    await waitFor(() => expect(useQueryLogStore.getState().entries[0]).toMatchObject({ cancelled: true }))
    expect(screen.getByText(/Press .*Enter to run a query/)).toBeInTheDocument()
  })

  it('propagates a non-abort query failure and fills optional logging fields from an error result', async () => {
    api.executeQuery.mockRejectedValueOnce(new Error('query exploded'))
    renderQuery()
    await setSql('SELECT 1')
    await act(async () => {
      await expect(editor.props!.onRun()).rejects.toThrow('query exploded')
    })

    api.executeQuery.mockResolvedValueOnce({
      columns: [],
      rows: [],
      row_count: undefined as never,
      exec_time_ms: undefined as never,
      error: 'bad result',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await act(async () => {})
    expect(useQueryLogStore.getState().entries[0].rowCount).toBeUndefined()
    expect(typeof useQueryLogStore.getState().entries[0].execTimeMs).toBe('number')
  })

  it('runs a multi-statement sequential script and switches between result tabs', async () => {
    const sequential: SequentialScriptResult = {
      ok: true,
      execution_id: 'e',
      statement_count: 2,
      statements_executed: 2,
      exec_time_ms: 4,
      result_sets: [
        { statement_index: 0, result_set_index: 0, sql: 'CREATE TABLE t (id INT)', result },
        {
          statement_index: 1,
          result_set_index: 0,
          sql: 'UPDATE t SET id = 2',
          result: { columns: [], rows: [], row_count: 0, affected_rows: 3, exec_time_ms: 1, truncated: true },
        },
      ],
    }
    api.executeSequentialScriptQuery.mockResolvedValue(sequential)
    renderQuery()
    await setSql('CREATE TABLE t (id INT); UPDATE t SET id = 2')
    await run_query()
    expect(await screen.findByRole('button', { name: 'Result 1 (1 row)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Result 2 (3 affected)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Result 2 (3 affected)' }))
    expect(await screen.findByTestId('result-grid')).toHaveTextContent('0')
    expect(api.getTables).toHaveBeenCalledWith('s', 'app')
  })

  it('surfaces sequential transport and script failures as extra result tabs', async () => {
    api.executeSequentialScriptQuery
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .mockRejectedValueOnce(new Error('network down'))
    renderQuery()
    await setSql('SET @x = 1; SELECT @x')
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent(/Script cancelled/)

    fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SET @x = 2; SELECT @x' } })
    await run_query()
    await waitFor(() => expect(useQueryLogStore.getState().entries[0].error).toContain('network down'))
    expect(screen.getByTestId('result-grid')).toHaveTextContent(/network down/)
  })

  it('labels multiple error and truncated result tabs', async () => {
    api.executeSequentialScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statement_count: 2,
      statements_executed: 2,
      exec_time_ms: 2,
      result_sets: [
        { statement_index: 0, result_set_index: 0, sql: 'SELECT bad', result: { ...result, error: 'bad' } },
        { statement_index: 1, result_set_index: 1, sql: 'SELECT extra', result: { ...result, truncated: true } },
      ],
    })
    renderQuery()
    await setSql('SELECT bad; SELECT extra')
    await run_query()
    expect(await screen.findByRole('button', { name: '✗ Result 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Result 2 (1 row) — truncated' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '✗ Result 1' }))
    expect(screen.getByTestId('result-grid')).toHaveTextContent('ERROR:bad')
  })

  it('suppresses the extra sequence error when an executed statement already failed', async () => {
    api.executeSequentialScriptQuery.mockResolvedValue({
      ok: false,
      execution_id: 'e',
      statement_count: 2,
      statements_executed: 1,
      exec_time_ms: 2,
      error: 'script failed',
      result_sets: [
        {
          statement_index: 0,
          result_set_index: 0,
          sql: 'SELECT bad',
          result: { ...result, error: 'inner failure' },
        },
      ],
    })
    renderQuery()
    await setSql('SELECT bad; SELECT 2')
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent('ERROR:inner failure')
    expect(screen.queryByText('script failed')).not.toBeInTheDocument()
  })

  it('falls back to String(error), empty failure metadata, and undefined optional result fields', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: false,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
      error: { code: 'X', problem: 'p', cause: 'c', fix: 'f', docs_url: '/d' },
    })
    renderQuery()
    await setSql(Array.from({ length: 25 }, (_, i) => `INSERT INTO t VALUES (${i})`).join(';'))
    await run_query()
    expect(grid.props?.result.rows).toEqual([
      ['Status', 'Unsupported large write script'],
      ['Statement count', 25],
      ['Rejected statement', ''],
      ['Preview', ''],
    ])

    api.executeSequentialScriptQuery.mockRejectedValue(new Error(''))
    await setSql('SET @x = 1; SELECT @x')
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent(/Error/)

    api.executeQuery.mockResolvedValue({
      columns: ['x'],
      rows: [[1]],
      row_count: 1,
      exec_time_ms: 1,
    })
    await setSql('SELECT 1')
    await run_query()
    expect(useQueryLogStore.getState().entries[0]).toMatchObject({ sql: 'SELECT 1' })
  })

  it('cancels a single query and ignores a kill failure', async () => {
    const pending = deferred<QueryResult>()
    api.executeQuery.mockImplementation((_session, _sql, _db, _limit, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        pending.promise.then(resolve, reject)
      }),
    )
    api.killQuery.mockRejectedValue(new Error('kill failed'))
    renderQuery()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel query' })
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    await waitFor(() => expect(api.killQuery).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument())
  })
})

describe('QueryTab large-write flows', () => {
  const insertSql = Array.from({ length: 25 }, (_, i) => `INSERT INTO t VALUES (${i})`).join(';')
  const updateSql = Array.from({ length: 25 }, (_, i) => `UPDATE t SET id = ${i}`).join(';')

  it('shows a rejected validation as a query error and logs it', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: false,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
      rejected_statement_index: 4,
      rejected_statement_preview: 'INSERT bad',
      error: {
        code: 'UNSUPPORTED',
        problem: 'Not supported',
        cause: 'Bad statement',
        fix: 'Change it',
        docs_url: '/docs',
      },
    })
    renderQuery()
    await setSql(insertSql)
    await run_query()
    expect(await screen.findByTestId('result-grid')).toHaveTextContent(/Not supported/)
    expect(useQueryLogStore.getState().entries[0].error).toContain('Not supported')
  })

  it('executes an INSERT-only script without confirmation and summarizes the bulk result', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
    })
    api.executeScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statements_executed: 25,
      affected_rows: 25,
      exec_time_ms: 8,
      rolled_back: false,
    })
    renderQuery()
    await setSql(insertSql)
    await run_query()
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('committed')
    expect(api.executeScriptQuery).toHaveBeenCalledOnce()
    expect(useQueryLogStore.getState().entries[0].bulk).toMatchObject({
      statementCount: 25,
      operationCounts: { INSERT: 25 },
    })
  })

  it('requires confirmation for destructive bulk writes, then runs or closes the dialog', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { UPDATE: 25 },
    })
    api.executeScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statements_executed: 25,
      affected_rows: 25,
      exec_time_ms: 8,
      rolled_back: false,
    })
    renderQuery()
    await setSql(updateSql)
    await run_query()
    expect(await screen.findByRole('dialog', { name: 'Review bulk write' })).toBeInTheDocument()
    expect(screen.getByText(/Large write script: 25 statements/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk' }))
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('committed')
    expect(api.executeScriptQuery).toHaveBeenCalledOnce()
  })

  it('closes a pending bulk confirmation without running the script', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { DELETE: 25 },
    })
    renderQuery()
    await setSql(Array.from({ length: 25 }, (_, i) => `DELETE FROM t WHERE id = ${i}`).join(';'))
    await run_query()
    expect(await screen.findByRole('dialog', { name: 'Review bulk write' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel bulk' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review bulk write' })).not.toBeInTheDocument())
    expect(api.executeScriptQuery).not.toHaveBeenCalled()
  })

  it('turns an aborted bulk script into a cancelled result and uses targeted cancellation', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
    })
    api.executeScriptQuery.mockImplementation((_session, _payload, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }),
    )
    renderQuery()
    await setSql(insertSql)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel query' })
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('CANCELLED_ROLLED_BACK')
    expect(api.killScriptQuery).toHaveBeenCalledOnce()
    expect(useQueryLogStore.getState().entries[0].sql).toBe(insertSql)
    expect(useQueryLogStore.getState().entries[0].bulk?.fullSql).toBe(insertSql)
  })

  it('reports an unknown bulk outcome when the request fails without aborting', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
    })
    api.executeScriptQuery.mockRejectedValue(new Error('connection reset'))
    renderQuery()
    await setSql(insertSql)
    await run_query()
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('OUTCOME_UNKNOWN')
    expect(useQueryLogStore.getState().entries[0].bulk?.rolledBack).toBe(false)
  })

  it('shows the in-flight statement count before validation resolves and truncates long SQL logs', async () => {
    const validation = deferred<Record<string, unknown>>()
    api.validateScriptQuery.mockReturnValue(validation.promise)
    api.executeScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statements_executed: 25,
      affected_rows: 25,
      exec_time_ms: 8,
      rolled_back: false,
    })
    renderQuery()
    await setSql(insertSql + ';' + ' '.repeat(600))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByText(/Large write script: 25 statements/)).toBeInTheDocument()
    await act(async () => {
      validation.resolve({ ok: true, statement_count: 25, operation_counts: { INSERT: 25 } })
    })
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('committed')
    expect(useQueryLogStore.getState().entries[0].sql.endsWith('…')).toBe(true)
  })

  it('logs short bulk SQL without a truncation marker', async () => {
    const shortSql = Array.from({ length: 25 }, () => 'INSERT t VALUES(0)').join(';')
    expect(shortSql.length).toBeLessThan(500)
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
    })
    api.executeScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statements_executed: 25,
      affected_rows: 25,
      exec_time_ms: 8,
      rolled_back: false,
    })
    renderQuery()
    await setSql(shortSql)
    await run_query()
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('committed')
    expect(useQueryLogStore.getState().entries[0].sql).toBe(shortSql)
  })

  it('keeps an opened export dialog mounted when the tab loses its database', async () => {
    const { rerender } = renderQuery()
    await run_query()
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('dialog', { name: 'Export result' })).toBeInTheDocument()
    rerender(<TabContent tab={{ ...queryTab, database: undefined }} />)
    expect(screen.queryByRole('dialog', { name: 'Export result' })).not.toBeInTheDocument()
  })
})

describe('QueryTab editor and environment wiring', () => {
  it('filters databases, appends the active database, and builds alias schema entries', async () => {
    useSessionStore.setState({ sessions: [{ ...session, selected_databases: ['analytics'] }] })
    useSchemaStore.setState({
      tables: { 's/app': [{ name: 'users', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 1, data_length: 1, comment: '' }] },
      columns: { 's/app/users': [{ name: 'id', data_type: 'int', column_type: 'int', is_nullable: false, column_default: null, is_primary_key: true, is_auto_increment: true, extra: '', comment: '' }] },
    })
    renderQuery()
    await setSql('SELECT * FROM users u WHERE u.id = 1')
    expect(editor.props?.databases).toEqual(['analytics', 'app'])
    expect(editor.props?.schema).toMatchObject({ users: ['id'], u: ['id'] })
  })

  it('applies pending SQL and database injection from the tab store', async () => {
    useTabStore.setState({
      tabs: [{ ...queryTab, database: 'app', sql: '' }],
      pendingSqls: { q: { sql: 'SELECT injected', database: 'analytics' } },
    })
    renderQuery()
    await waitFor(() => expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT injected'))
    expect(useTabStore.getState().tabs[0].database).toBe('analytics')
    expect(useTabStore.getState().pendingSqls.q).toBeUndefined()
  })

  it('uses empty store/SQL fallbacks without a database and ignores empty or comment-only runs', async () => {
    useTabStore.setState({ tabs: [], pendingSqls: {} })
    const tab = { ...queryTab, id: 'missing', database: undefined }
    renderQuery(tab)
    expect(editor.props?.value).toBe('')
    expect(editor.props?.databases).toEqual(['app', 'analytics'])
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await setSql(';;')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await setSql('SELECT 1')
    editor.props!.editorRef.current = null
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await act(async () => {})
    expect(api.executeQuery).toHaveBeenCalledOnce()
  })

  it('uses empty database and table caches when session metadata has not loaded', () => {
    useSchemaStore.setState({ databases: {}, tables: {}, columns: {} })
    renderQuery()
    expect(editor.props?.databases).toEqual(['app'])
    expect(editor.props?.schema).toEqual({})
  })

  it('parses comma aliases, skips alias clobbering, and loads referenced columns', async () => {
    vi.useFakeTimers()
    try {
      useSchemaStore.setState({
        tables: {
          's/app': [
            { name: 'users', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 1, data_length: 1, comment: '' },
            { name: 'orders', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 1, data_length: 1, comment: '' },
            { name: 'u', table_type: 'BASE TABLE', engine: 'InnoDB', row_count: 1, data_length: 1, comment: '' },
          ],
        },
        columns: {
          's/app/u': [{ name: 'shadow', data_type: 'int', column_type: 'int', is_nullable: false, column_default: null, is_primary_key: false, is_auto_increment: false, extra: '', comment: '' }],
        },
      })
      renderQuery()
      await act(async () => {
        fireEvent.change(screen.getByLabelText('SQL editor'), {
          target: { value: 'SELECT * FROM users u, orders o WHERE u.id = o.id' },
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })
      expect(editor.props?.schema).toMatchObject({ u: ['shadow'], orders: [] })
      expect(editor.props?.schema.o).toEqual([])
      expect(api.getColumns).toHaveBeenCalledWith('s', 'app', 'users')
      api.getColumns.mockClear()
      await act(async () => {
        fireEvent.change(screen.getByLabelText('SQL editor'), {
          target: { value: 'SELECT * FROM users, orders WHERE users.id = orders.id' },
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })
      expect(api.getColumns).toHaveBeenCalledWith('s', 'app', 'orders')
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles missing function metadata, pending SQL without a database, and UI callbacks', async () => {
    api.getFunctions.mockRejectedValue(new Error('no functions'))
    useTabStore.setState({ pendingSqls: { q: { sql: 'SELECT 9' } } })
    renderQuery()
    await waitFor(() => expect(screen.getByLabelText('SQL editor')).toHaveValue('SELECT 9'))
    expect(editor.props?.functions).toEqual([])
    expect(useTabStore.getState().tabs[0].database).toBe('app')
    act(() => {
      editor.props?.onDatabaseChange('analytics')
      editor.props?.onWordWrapChange(false)
    })
    expect(useTabStore.getState().tabs[0].database).toBe('analytics')
    expect(localStorage.getItem('lagun-query-word-wrap')).toBe('false')
  })

  it('restores persisted editor height and word-wrap state', () => {
    localStorage.setItem('lagun-query-editor-height', '321')
    localStorage.setItem('lagun-query-word-wrap', 'false')
    const { container } = renderQuery()
    expect(editor.props?.wordWrap).toBe(false)
    expect((container.firstElementChild?.firstElementChild as HTMLElement).style.height).toBe('321px')
  })

  it('debounces SQL persistence to the tab store and flushes on unmount', async () => {
    vi.useFakeTimers()
    try {
      const view = renderQuery()
      await act(async () => {
        fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 42' } })
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(useTabStore.getState().tabs[0]).toMatchObject({ sql: 'SELECT 42', dirty: true })
      act(() => {
        fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 43' } })
      })
      view.unmount()
      expect(useTabStore.getState().tabs[0].sql).toBe('SELECT 43')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resizes the editor by pointer and keyboard with persisted bounds', async () => {
    vi.useFakeTimers()
    try {
      const { container } = renderQuery()
      const divider = screen.getByRole('button', { name: 'Resize query editor' })
      const wrapper = container.firstElementChild as HTMLElement
      Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: 400 })
      fireEvent.mouseDown(divider, { clientY: 100 })
      fireEvent.mouseMove(document, { clientY: 300 })
      fireEvent.mouseUp(document)
      expect(localStorage.getItem('lagun-query-editor-height')).toBe('280')
      fireEvent.keyDown(divider, { key: 'ArrowDown' })
      expect(localStorage.getItem('lagun-query-editor-height')).toBe('280')
      fireEvent.keyDown(divider, { key: 'ArrowUp' })
      expect(localStorage.getItem('lagun-query-editor-height')).toBe('264')
      fireEvent.keyDown(divider, { key: 'x' })
      expect(localStorage.getItem('lagun-query-editor-height')).toBe('264')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the Mac run hint when the platform reports macOS', () => {
    platform.isMac = true
    renderQuery()
    expect(screen.getByText('⌘Enter', { exact: false })).toBeInTheDocument()
  })

  it('falls back to the default bulk failure cause when the error message is empty', async () => {
    api.validateScriptQuery.mockResolvedValue({
      ok: true,
      statement_count: 25,
      operation_counts: { INSERT: 25 },
    })
    api.executeScriptQuery.mockRejectedValue(new Error(''))
    renderQuery()
    await setSql(Array.from({ length: 25 }, (_, i) => `INSERT INTO t VALUES (${i})`).join(';'))
    await run_query()
    expect(await screen.findByTestId('bulk-summary')).toHaveTextContent('OUTCOME_UNKNOWN')
    expect(bulkSummary.props?.error?.cause).toBe(
      'The request failed before Lagun received a final commit or rollback response.',
    )
  })

  it('tolerates missing optional fields in sequential results and labels zero affected rows', async () => {
    api.executeSequentialScriptQuery.mockResolvedValue({
      ok: true,
      execution_id: 'e',
      statement_count: 2,
      statements_executed: 2,
      exec_time_ms: 2,
      result_sets: [
        { statement_index: 0, result_set_index: 0, sql: 'SELECT 1', result },
        {
          statement_index: 1,
          result_set_index: 0,
          sql: 'UPDATE t',
          result: {
            columns: [],
            rows: [],
            row_count: undefined as never,
            exec_time_ms: undefined as never,
            affected_rows: undefined,
          },
        },
      ],
    })
    renderQuery()
    await setSql('SELECT 1; UPDATE t')
    await run_query()
    expect(await screen.findByRole('button', { name: 'Result 2 (0 affected)' })).toBeInTheDocument()
    expect(useQueryLogStore.getState().entries[0].rowCount).toBeUndefined()
  })
})
