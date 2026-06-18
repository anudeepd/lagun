import { describe, it, expect } from 'vitest'
import type { QueryResult } from '../../types'
import { buildResultGridRowData } from '../../components/editor/ResultGrid'
import { normalizeDataTabState, shouldKeepPreviousResultOnLoad } from '../../components/editor/TabContent'

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

    const rows = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })

    expect(rows.map(row => row.__ag_rowId)).toEqual(['1', '2'])
  })
})

describe('query result export metadata', () => {
  it('uses the active result statement instead of the full editor SQL', () => {
    const editorSql = 'SELECT 1; SELECT 2;'
    const executedResults = [
      { result: makeResult(['one'], [[1]]), sql: 'SELECT 1' },
      { result: makeResult(['two'], [[2]]), sql: 'SELECT 2' },
    ]
    const activeResultIdx = 1

    expect(executedResults[activeResultIdx].sql).toBe('SELECT 2')
    expect(executedResults[activeResultIdx].sql).not.toBe(editorSql)
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

  it('places a duplicated row draft immediately below the source row', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 2, name: 'Bob' })
    const anchors = new Map([['__insert__1', { afterRowId: '2' }]])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual(['1', '2', '__insert__1', '3'])
    expect(rows[2].__lagun_insertDraft).toBe(true)
    expect(rows[2].name).toBe('Bob')
  })

  it('preserves creation order for multiple drafts from the same source row', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 2, name: 'Bob copy 1' })
    drafts.set('__insert__2', { id: 2, name: 'Bob copy 2' })
    const anchors = new Map([
      ['__insert__1', { afterRowId: '2' }],
      ['__insert__2', { afterRowId: '2' }],
    ])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual(['1', '2', '__insert__1', '__insert__2', '3'])
  })

  it('appends drafts when the source row is no longer in the result set', () => {
    const drafts = new Map<string, Record<string, unknown>>()
    drafts.set('__insert__1', { id: 99, name: 'Detached' })
    const anchors = new Map([['__insert__1', { afterRowId: '99' }]])

    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: drafts,
      insertDraftAnchors: anchors,
    })

    expect(rows.map(row => row.__ag_rowId)).toEqual(['1', '2', '3', '__insert__1'])
  })
})
