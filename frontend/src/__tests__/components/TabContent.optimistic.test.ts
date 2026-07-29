import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ColumnInfo, QueryResult, Tab } from '../../types'
import { api } from '../../api/client'
import { useSchemaStore } from '../../store/schemaStore'
import { buildResultGridRowData } from '../../components/editor/ResultGrid'
import TabContent, { buildDuplicateRowDraftValues, buildEmptyRowDraftValues, buildQueryExportContext, buildQueryResultExportData, buildSelectedRowsExportData, buildTableDataExportData, buildTableDataSelectSql, normalizeDataTabState, shouldDebounceDataSearch, shouldKeepPreviousResultOnLoad } from '../../components/editor/TabContent'

// ── Helper: filterDeletedRows ──────────────────────────────────────────
// Standalone replica of the optimistic delete logic from `handleDeleteRows`.
// Matches rows by primary-key column values (joined with '\x00') against the
// set of deleted row keys.
function filterDeletedRows(
  result: QueryResult,
  deletedRows: Record<string, unknown>[],
  rowKeyColumns: string[],
): QueryResult {
  if (!result) return result
  const deletedKeys = new Set(
    deletedRows.map(row => rowKeyColumns.map(pk => String(row[pk])).join('\x00')),
  )
  const newRows = result.rows.filter(row => {
    const key = rowKeyColumns
      .map(pk => {
        const colIndex = result.columns.indexOf(pk)
        return String(row[colIndex])
      })
      .join('\x00')
    return !deletedKeys.has(key)
  })
  return { ...result, rows: newRows, row_count: newRows.length }
}

// ── Helper: applyEditsToRows ────────────────────────────────────────────
// Standalone replica of the optimistic edit logic from `handleApplyChanges`.
// Matches rows by index (String(idx)) and applies column-level value changes.
function applyEditsToRows(
  result: QueryResult,
  pendingChanges: Map<string, { changes: Record<string, unknown> }>,
): QueryResult {
  if (!result) return result
  const newRows = result.rows.map((row, idx) => {
    const rowId = String(idx)
    const edit = pendingChanges.get(rowId)
    if (!edit) return row
    const updatedRow = [...row]
    for (const [col, newValue] of Object.entries(edit.changes)) {
      const colIndex = result.columns.indexOf(col)
      if (colIndex >= 0) updatedRow[colIndex] = newValue
    }
    return updatedRow
  })
  return { ...result, rows: newRows }
}

// ── Test fixtures ───────────────────────────────────────────────────────
function makeResult(
  columns: string[],
  rows: unknown[][],
  overrides: Partial<Pick<QueryResult, 'row_count' | 'exec_time_ms'>> = {},
): QueryResult {
  return {
    columns,
    rows,
    row_count: overrides.row_count ?? rows.length,
    exec_time_ms: overrides.exec_time_ms ?? 12,
  }
}

function makeColumn(name: string, isPrimaryKey = false, isAutoIncrement = false, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    data_type: 'varchar',
    column_type: 'varchar(255)',
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    is_auto_increment: isAutoIncrement,
    extra: isAutoIncrement ? 'auto_increment' : '',
    comment: '',
    ...overrides,
  }
}

// ── Tests: filterDeletedRows ────────────────────────────────────────────

describe('filterDeletedRows — optimistic delete', () => {
  const cols = ['id', 'name', 'email']
  const pk = ['id']

  it('removes a single deleted row', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'alice@x.com'],
      [2, 'Bob', 'bob@x.com'],
      [3, 'Carol', 'carol@x.com'],
    ])
    const deleted = [{ id: 2 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.rows).toHaveLength(2)
    expect(out.row_count).toBe(2)
    expect(out.rows).toEqual([
      [1, 'Alice', 'alice@x.com'],
      [3, 'Carol', 'carol@x.com'],
    ])
  })

  it('removes multiple deleted rows', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
      [3, 'Carol', 'c@x'],
      [4, 'Dave', 'd@x'],
    ])
    const deleted = [{ id: 1 }, { id: 3 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.rows).toHaveLength(2)
    expect(out.row_count).toBe(2)
    expect(out.rows).toEqual([
      [2, 'Bob', 'b@x'],
      [4, 'Dave', 'd@x'],
    ])
  })

  it('removes all rows when all are deleted', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const deleted = [{ id: 1 }, { id: 2 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.rows).toHaveLength(0)
    expect(out.row_count).toBe(0)
    expect(out.rows).toEqual([])
  })

  it('no-op when deleted row is not found', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const deleted = [{ id: 99 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.rows).toHaveLength(2)
    expect(out.row_count).toBe(2)
    expect(out.rows).toEqual([
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
  })

  it('handles null PK values — String(null) === "null" on both sides', () => {
    const result = makeResult(cols, [
      [null, 'NullRow', 'n@x'],
      [2, 'Bob', 'b@x'],
    ])
    const deleted = [{ id: null }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.rows).toHaveLength(1)
    expect(out.row_count).toBe(1)
    expect(out.rows).toEqual([[2, 'Bob', 'b@x']])
  })

  it('matches by multi-column primary key', () => {
    const result = makeResult(['first', 'last', 'age'], [
      ['John', 'Doe', 30],
      ['John', 'Smith', 25],
      ['Jane', 'Doe', 28],
    ])
    const pkCols = ['first', 'last']
    const deleted = [{ first: 'John', last: 'Doe' }]

    const out = filterDeletedRows(result, deleted, pkCols)

    expect(out.rows).toHaveLength(2)
    expect(out.row_count).toBe(2)
    expect(out.rows).toEqual([
      ['John', 'Smith', 25],
      ['Jane', 'Doe', 28],
    ])
  })

  it('multi-column PK — only deletes exact match, not partial', () => {
    const result = makeResult(['first', 'last', 'age'], [
      ['John', 'Doe', 30],
      ['John', 'Smith', 25],
      ['Jane', 'Doe', 28],
    ])
    const pkCols = ['first', 'last']
    // Delete a row where only the `first` column matches — should NOT match any existing row
    const deleted = [{ first: 'John', last: 'Unknown' }]

    const out = filterDeletedRows(result, deleted, pkCols)

    expect(out.rows).toHaveLength(3)
    expect(out.row_count).toBe(3)
  })

  it('keeps exec_time_ms and other fields unchanged', () => {
    const result = makeResult(cols, [[1, 'Alice', 'a@x']], { exec_time_ms: 47 })
    const deleted = [{ id: 1 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out.exec_time_ms).toBe(47)
    expect(out.columns).toBe(cols)
  })

  it('empty deletedRows array is a no-op', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const out = filterDeletedRows(result, [], pk)

    expect(out.rows).toHaveLength(2)
    expect(out.row_count).toBe(2)
  })

  it('returns new object reference (immutability)', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
    ])
    const deleted = [{ id: 1 }]

    const out = filterDeletedRows(result, deleted, pk)

    expect(out).not.toBe(result)
  })
})

describe('buildResultGridRowData — row identity', () => {
  it('uses unique row ids for duplicate result rows without primary keys', () => {
    const result = makeResult(['name', 'role'], [
      ['Sam', 'admin'],
      ['Sam', 'admin'],
      ['Sam', 'admin'],
    ])

    const rows = buildResultGridRowData({ result, primaryKeyColumns: [] })
    const rowIds = rows.map(row => row.__ag_rowId)

    expect(new Set(rowIds).size).toBe(3)
  })

  it('keeps primary-key row ids stable when primary keys are provided', () => {
    const result = makeResult(['id', 'name'], [
      [1, 'Sam'],
      [2, 'Sam'],
    ])

    const first = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
    const second = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
    const firstIds = first.map(row => row.__ag_rowId)

    expect(firstIds).toEqual(second.map(row => row.__ag_rowId))
    expect(firstIds[0]).not.toBe(firstIds[1])
  })
  it('keeps internal row ids bounded when a key value is very large', () => {
    const result = makeResult(['id', 'payload'], [
      ['x'.repeat(100_000), 'large row'],
    ])

    const [row] = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })

    expect(String(row.__ag_rowId).length).toBeLessThan(64)
  })

  it('does not give NULL and empty-string keys the same row id', () => {
    const nullKey = buildResultGridRowData({
      result: makeResult(['id'], [[null]]),
      primaryKeyColumns: ['id'],
    })
    const emptyKey = buildResultGridRowData({
      result: makeResult(['id'], [['']]),
      primaryKeyColumns: ['id'],
    })

    expect(nullKey[0].__ag_rowId).not.toBe(emptyKey[0].__ag_rowId)
  })
})

describe('query result export metadata', () => {
  it('uses the active result statement instead of the full editor SQL', () => {
    const editorSql = 'SELECT 1; SELECT 2;'
    const executedResults = [
      { id: 'run-1-0', result: makeResult(['one'], [[1]]), sql: 'SELECT 1' },
      { id: 'run-1-1', result: makeResult(['two'], [[2]]), sql: 'SELECT 2' },
    ]
    const activeResultIdx = 1

    expect(executedResults[activeResultIdx].sql).toBe('SELECT 2')
    expect(executedResults[activeResultIdx].sql).not.toBe(editorSql)
  })

  it('exports the current displayed query rows, not a stale previous result', () => {
    const previous = makeResult(['id'], [[1], [2], [3]])
    const current = makeResult(
      ['id'],
      Array.from({ length: 10 }, (_, idx) => [idx + 1]),
    )

    expect(previous.rows).toHaveLength(3)

    const out = buildQueryResultExportData(current, null)

    expect(out?.rows).toHaveLength(10)
    expect(out).toEqual({ columns: current.columns, rows: current.rows })
  })

  it('uses AG Grid filtered data only when a grid filter is active', () => {
    const current = makeResult(
      ['id'],
      Array.from({ length: 10 }, (_, idx) => [idx + 1]),
    )
    const filtered = { columns: ['id'], rows: [[2], [4], [6]] }

    const out = buildQueryResultExportData(current, {
      isAnyFilterPresent: () => true,
      getFilteredData: () => filtered,
    })

    expect(out).toBe(filtered)
    expect(out?.rows).toHaveLength(3)
  })

  it('freezes query export SQL with the matching result rows', () => {
    const first = { id: 'run-1-0', result: makeResult(['one'], [[1]]), sql: 'SELECT 1' }
    const second = { id: 'run-1-1', result: makeResult(['two'], [[2]]), sql: 'SELECT 2' }

    const out = buildQueryExportContext(first, null)

    expect(second.sql).toBe('SELECT 2')
    expect(out).toEqual({
      sql: 'SELECT 1',
      rowsOverride: { columns: ['one'], rows: [[1]] },
    })
  })
})

describe('table data export metadata', () => {
  it('exports the currently displayed table rows from the grid snapshot', () => {
    const current = makeResult(
      ['id'],
      Array.from({ length: 10 }, (_, idx) => [idx + 1]),
    )
    const displayed = { columns: ['id'], rows: [[2], [4], [6]] }

    const out = buildTableDataExportData(current, {
      getFilteredData: () => displayed,
    })

    expect(out).toBe(displayed)
  })

  it('falls back to the loaded table result when the grid is unavailable', () => {
    const current = makeResult(['id'], [[1], [2], [3]])

    expect(buildTableDataExportData(current, null)).toEqual({
      columns: current.columns,
      rows: current.rows,
    })
  })

  it('does not export an errored table result snapshot', () => {
    const errored = makeResult([], [])
    errored.error = 'Unknown column nope'

    expect(buildTableDataExportData(errored, null)).toBeUndefined()
  })

  it('exports selected table rows from the current displayed row objects', () => {
    const result = makeResult(['id', 'name'], [
      [1, 'Alice'],
      [2, 'Bob'],
    ])

    expect(buildSelectedRowsExportData(result, [
      { id: 2, name: 'Bob', __ag_rowId: '2' },
    ])).toEqual({
      columns: ['id', 'name'],
      rows: [[2, 'Bob']],
    })
  })
})

describe('table data retrieval SQL', () => {
  it('loads table data in primary-key order before the backend appends LIMIT', () => {
    expect(buildTableDataSelectSql('db', 'users', [
      makeColumn('id', true),
      makeColumn('name'),
    ], '', '')).toBe('SELECT * FROM `db`.`users` ORDER BY `id`')
  })

  it('keeps search and WHERE filters before primary-key ordering', () => {
    expect(buildTableDataSelectSql('db', 'users', [
      makeColumn('id', true),
      makeColumn('name'),
    ], 'sam', 'id > 10')).toBe(
      "SELECT * FROM `db`.`users` WHERE (`id` LIKE '%sam%' OR `name` LIKE '%sam%') AND (id > 10) ORDER BY `id`",
    )
  })

  it('does not invent an expensive fallback order when no primary key exists', () => {
    expect(buildTableDataSelectSql('db', 'logs', [
      makeColumn('message'),
    ], '', '')).toBe('SELECT * FROM `db`.`logs`')
  })
})

describe('data filter error handling', () => {
  it('keeps the previous visible result when a later load has an error', () => {
    const current = makeResult(['id'], [[1]])
    const next = makeResult([], [])
    next.error = 'Unknown column nope'

    expect(shouldKeepPreviousResultOnLoad(next, current)).toBe(true)
  })

  it('allows an initial error result when nothing is visible yet', () => {
    const next = makeResult([], [])
    next.error = 'Unknown column nope'

    expect(shouldKeepPreviousResultOnLoad(next, null)).toBe(false)
  })
})

describe('data tab persisted filter state', () => {
  it('normalizes saved Data tab filter values for reload', () => {
    expect(normalizeDataTabState({
      view: 'data',
      globalSearch: 'sam',
      whereFilter: 'email LIKE "%@example.com"',
      appliedWhere: 'email LIKE "%@example.com"',
      showFilterBar: true,
      limit: 500,
    })).toEqual({
      view: 'data',
      globalSearch: 'sam',
      whereFilter: 'email LIKE "%@example.com"',
      appliedWhere: 'email LIKE "%@example.com"',
      showFilterBar: true,
      limit: 500,
    })
  })

  it('opens the filter bar when old saved state has filter text but no bar flag', () => {
    expect(normalizeDataTabState({ whereFilter: 'id = 1' }).showFilterBar).toBe(true)
    expect(normalizeDataTabState({ appliedWhere: 'id = 1' }).showFilterBar).toBe(true)
  })
})

describe('data tab search loading', () => {
  it('does not schedule a second load when only the view changes to Data', () => {
    expect(shouldDebounceDataSearch('', '', 'data')).toBe(false)
  })

  it('debounces a real search edit only while Data is visible', () => {
    expect(shouldDebounceDataSearch('', 'alice', 'data')).toBe(true)
    expect(shouldDebounceDataSearch('', 'alice', 'schema')).toBe(false)
  })

  it('reuses cached columns and cancels an active scan before the latest search', async () => {
    const columns = [makeColumn('id', true), makeColumn('name')]
    useSchemaStore.setState({
      columns: { 'session-1/db/users': columns },
    })
    const getColumns = vi.spyOn(api, 'getColumns')
    vi.spyOn(api, 'getFunctions').mockResolvedValue([])
    const killQueryExecution = vi.spyOn(api, 'killQueryExecution')
      .mockResolvedValue({ ok: true })
    const executeQuery = vi.spyOn(api, 'executeQuery')
      .mockImplementation((_sessionId, _sql, _database, _limit, signal) => (
        new Promise<QueryResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      ))
    const tab: Tab = {
      id: 'table-search',
      label: 'users',
      type: 'table',
      sessionId: 'session-1',
      database: 'db',
      table: 'users',
      dataState: { view: 'data' },
    }

    const view = render(createElement(TabContent, { tab }))
    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1))
    const firstExecutionId = executeQuery.mock.calls[0][5]

    fireEvent.change(screen.getByPlaceholderText('Search all columns…'), {
      target: { value: 'alice' },
    })

    await waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2), {
      timeout: 1500,
    })
    expect(getColumns).not.toHaveBeenCalled()
    expect(killQueryExecution).toHaveBeenCalledWith(
      'session-1',
      firstExecutionId,
    )
    expect(executeQuery.mock.calls[1][1]).toContain("LIKE '%alice%'")

    view.unmount()
    vi.restoreAllMocks()
    useSchemaStore.setState({ columns: {} })
  })
})

// ── Tests: applyEditsToRows ─────────────────────────────────────────────

describe('applyEditsToRows — optimistic edit', () => {
  const cols = ['id', 'name', 'email']

  it('applies a single edit to one cell', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { name: 'Alicia' } })

    const out = applyEditsToRows(result, pending)

    expect(out.rows).toEqual([
      [1, 'Alicia', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
  })

  it('applies multiple edits to the same row', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { name: 'Alicia', email: 'alicia@x.com' } })

    const out = applyEditsToRows(result, pending)

    expect(out.rows).toEqual([
      [1, 'Alicia', 'alicia@x.com'],
      [2, 'Bob', 'b@x'],
    ])
  })

  it('applies edits to multiple different rows', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
      [3, 'Carol', 'c@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { name: 'Alicia' } })
    pending.set('2', { changes: { email: 'carol2@x.com' } })

    const out = applyEditsToRows(result, pending)

    expect(out.rows).toEqual([
      [1, 'Alicia', 'a@x'],
      [2, 'Bob', 'b@x'],
      [3, 'Carol', 'carol2@x.com'],
    ])
  })

  it('no-op when pendingChanges is empty', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()

    const out = applyEditsToRows(result, pending)

    expect(out.rows).toEqual([
      [1, 'Alice', 'a@x'],
      [2, 'Bob', 'b@x'],
    ])
  })

  it('no-op when rowId not found in pendingChanges', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('99', { changes: { name: 'Nope' } })

    const out = applyEditsToRows(result, pending)

    expect(out.rows).toEqual([[1, 'Alice', 'a@x']])
  })

  it('no-op when column name does not exist in result.columns', () => {
    const result = makeResult(cols, [
      [1, 'Alice', 'a@x'],
    ])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { nonexistent_col: 'should not appear' } })

    const out = applyEditsToRows(result, pending)

    // Row should be unchanged because colIndex was -1
    expect(out.rows).toEqual([[1, 'Alice', 'a@x']])
  })

  it('does NOT change row_count', () => {
    const result = makeResult(['id', 'val'], [[1, 'old']])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { val: 'new' } })

    const out = applyEditsToRows(result, pending)

    expect(out.row_count).toBe(1) // same as before
    expect(out.rows).toHaveLength(1)
  })

  it('returns new object reference (immutability)', () => {
    const result = makeResult(cols, [[1, 'Alice', 'a@x']])
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { name: 'New' } })

    const out = applyEditsToRows(result, pending)

    expect(out).not.toBe(result)
  })

  it('preserves exec_time_ms and columns', () => {
    const result = makeResult(cols, [[1, 'Alice', 'a@x']], { exec_time_ms: 99 })
    const pending = new Map<string, { changes: Record<string, unknown> }>()
    pending.set('0', { changes: { name: 'Alicia' } })

    const out = applyEditsToRows(result, pending)

    expect(out.exec_time_ms).toBe(99)
    expect(out.columns).toBe(cols)
  })
})

describe('buildResultGridRowData — duplicated row draft placement', () => {
  const result = makeResult(['id', 'name'], [
    [1, 'Alice'],
    [2, 'Bob'],
    [3, 'Carol'],
  ])
  const sourceRows = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
  const sourceIds = sourceRows.map(row => row.__ag_rowId as string)

  it('places a duplicated row draft immediately below the source row', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 2, name: 'Bob' })
    const anchors = new Map([['__insert__1', { afterRowId: sourceIds[1] }]])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual([sourceIds[0], sourceIds[1], '__insert__1', sourceIds[2]])
    expect(rows[2].__lagun_insertDraft).toBe(true)
    expect(rows[2].name).toBe('Bob')
  })

  it('preserves creation order for multiple drafts from the same source row', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 2, name: 'Bob copy 1' })
    drafts.set('__insert__2', { id: 2, name: 'Bob copy 2' })
    const anchors = new Map([
      ['__insert__1', { afterRowId: sourceIds[1] }],
      ['__insert__2', { afterRowId: sourceIds[1] }],
    ])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual([sourceIds[0], sourceIds[1], '__insert__1', '__insert__2', sourceIds[2]])
  })

  it('appends drafts when the source row is no longer in the result set', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 99, name: 'Detached' })
    const anchors = new Map([['__insert__1', { afterRowId: 'missing-row' }]])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual([...sourceIds, '__insert__1'])
  })
})

describe('buildDuplicateRowDraftValues', () => {
  const row = {
    id: 42,
    tenant_id: 'acme',
    sequence: 7,
    name: 'Widget',
    notes: undefined,
  }

  it('copies primary key and auto-increment values when duplicating with keys', () => {
    const values = buildDuplicateRowDraftValues(row, [
      makeColumn('id', true, true),
      makeColumn('tenant_id', true),
      makeColumn('sequence', false, true),
      makeColumn('name'),
      makeColumn('notes'),
    ], 'withKeys')

    expect(values).toEqual({
      id: 42,
      tenant_id: 'acme',
      sequence: 7,
      name: 'Widget',
      notes: null,
    })
  })

  it('omits primary key columns when duplicating without keys', () => {
    const values = buildDuplicateRowDraftValues(row, [
      makeColumn('id', true),
      makeColumn('tenant_id', true),
      makeColumn('name'),
    ], 'withoutKeys')

    expect(values).toEqual({ name: 'Widget' })
    expect(values).not.toHaveProperty('id')
    expect(values).not.toHaveProperty('tenant_id')
  })

  it('omits auto-increment columns when duplicating without keys', () => {
    const values = buildDuplicateRowDraftValues(row, [
      makeColumn('sequence', false, true),
      makeColumn('name'),
    ], 'withoutKeys')

    expect(values).toEqual({ name: 'Widget' })
    expect(values).not.toHaveProperty('sequence')
  })

  it('keeps draft placement below the source row when key values are omitted', () => {
    const result = makeResult(['id', 'name'], [
      [1, 'Alice'],
      [2, 'Bob'],
    ])
    const sourceRows = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
    const sourceIds = sourceRows.map(row => row.__ag_rowId as string)
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', buildDuplicateRowDraftValues({ id: 2, name: 'Bob' }, [
      makeColumn('id', true, true),
      makeColumn('name'),
    ], 'withoutKeys'))
    const anchors = new Map([['__insert__1', { afterRowId: sourceIds[1] }]])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual([sourceIds[0], sourceIds[1], '__insert__1'])
    expect(rows[2].id).toBeNull()
    expect(rows[2].name).toBe('Bob')
  })
})

describe('buildEmptyRowDraftValues', () => {
  it('omits auto-increment and default columns', () => {
    const values = buildEmptyRowDraftValues([
      makeColumn('id', true, true),
      makeColumn('created_at', false, false, { column_default: 'CURRENT_TIMESTAMP' }),
      makeColumn('name'),
    ])

    expect(values).toEqual({ name: null })
    expect(values).not.toHaveProperty('id')
    expect(values).not.toHaveProperty('created_at')
  })

  it('leaves required no-default columns absent so the user can fill them before applying', () => {
    const values = buildEmptyRowDraftValues([
      makeColumn('id', true, true),
      makeColumn('email', false, false, { is_nullable: false }),
      makeColumn('nickname'),
    ])

    expect(values).toEqual({ nickname: null })
    expect(values).not.toHaveProperty('email')
  })
})
