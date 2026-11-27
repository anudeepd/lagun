import { describe, expect, it, vi } from 'vitest'
import {
  buildQueryExportContext,
  buildQueryResultExportData,
  buildSelectedRowsExportData,
  buildTableDataExportData,
  filterDeletedRows,
  needsBulkConfirmation,
  normalizeDataTabState,
  scriptResultToQueryResult,
  shouldDebounceDataSearch,
  shouldTryFastExecute,
  shouldUseSequentialExecute,
  splitStatements,
  statementsChangeSchema,
} from '../../components/editor/TabContent'
import type { QueryResult, ScriptQueryResult, ColumnInfo } from '../../types'

function column(name: string, autoIncrement = false): ColumnInfo {
  return {
    name,
    data_type: 'int',
    column_type: 'int',
    is_nullable: false,
    column_default: null,
    is_primary_key: false,
    is_auto_increment: autoIncrement,
    extra: '',
    comment: '',
  }
}

const queryResult: QueryResult = {
  columns: ['id', 'name'],
  rows: [[1, null], [2, 'Bob']],
  row_count: 2,
  exec_time_ms: 3,
}

function script(overrides: Partial<ScriptQueryResult> = {}): ScriptQueryResult {
  return {
    ok: false,
    execution_id: 'e',
    statements_executed: 4,
    affected_rows: 2,
    exec_time_ms: 9,
    rolled_back: false,
    ...overrides,
  }
}

describe('TabContent utility branches', () => {
  it('handles validation defaults and all script outcomes', () => {
    expect(needsBulkConfirmation({ ok: true, statement_count: 1, operation_counts: undefined as never })).toBe(false)
    expect(needsBulkConfirmation({ ok: true, statement_count: 1, operation_counts: { UPDATE: 1 } })).toBe(true)
    expect(needsBulkConfirmation({ ok: true, statement_count: 1, operation_counts: { DELETE: 1 } })).toBe(true)

    const cancelled = scriptResultToQueryResult(script({
      error: {
        code: 'CANCELLED_ROLLED_BACK',
        problem: 'cancelled',
        cause: 'cancel',
        fix: 'retry',
        docs_url: '/docs',
      },
      failed_statement_index: 0,
      failed_statement_preview: 'UPDATE users',
    }))
    expect(cancelled.rows[3][1]).toBe('Cancelled')
    expect(cancelled.rows).toContainEqual(['Failed statement', 1])
    expect(cancelled.rows).toContainEqual(['Failed preview', 'UPDATE users'])
    expect(cancelled.error).toContain('cancelled')

    expect(scriptResultToQueryResult(script({ rolled_back: true })).rows[3][1]).toBe('Rolled back')
    expect(scriptResultToQueryResult(script({ ok: true })).rows[3][1]).toBe('Committed')
    expect(scriptResultToQueryResult(script({ ok: false })).rows[3][1]).toBe('Not committed')
  })

  it('builds export overrides for no result, filtered grids, and raw results', () => {
    expect(buildQueryResultExportData(undefined, null)).toBeUndefined()
    expect(buildQueryResultExportData(queryResult, null)).toEqual({
      columns: queryResult.columns,
      rows: queryResult.rows,
    })
    const filtered = {
      columns: ['id'],
      rows: [[1]],
      isAnyFilterPresent: () => true,
      getFilteredData: () => ({ columns: ['id'], rows: [[1]] }),
    }
    expect(buildQueryResultExportData(queryResult, filtered)).toEqual({ columns: ['id'], rows: [[1]] })
    expect(buildQueryResultExportData(queryResult, { ...filtered, isAnyFilterPresent: () => false })).toEqual({
      columns: queryResult.columns,
      rows: queryResult.rows,
    })

    expect(buildQueryExportContext(undefined, null)).toBeNull()
    expect(buildQueryExportContext({ id: '1', sql: 'SELECT 1', result: queryResult }, null)).toEqual({
      sql: 'SELECT 1',
      rowsOverride: { columns: queryResult.columns, rows: queryResult.rows },
    })
  })

  it('builds table and selected-row exports with and without auto-increment metadata', () => {
    expect(buildTableDataExportData(null, null)).toBeUndefined()
    expect(buildTableDataExportData({ ...queryResult, error: 'bad' }, null)).toBeUndefined()
    expect(buildTableDataExportData(queryResult, null, [column('id')])).toEqual({
      columns: queryResult.columns,
      rows: queryResult.rows,
    })
    expect(buildTableDataExportData(queryResult, null, [column('id', true)])).toEqual({
      columns: queryResult.columns,
      rows: queryResult.rows,
      autoIncrementColumns: ['id'],
    })
    expect(buildTableDataExportData(queryResult, {
      getFilteredData: () => ({ columns: ['name'], rows: [['Bob']] }),
    })).toEqual({ columns: ['name'], rows: [['Bob']] })

    const rows = [{ id: 1, name: 'A' }, { id: 2 }]
    expect(buildSelectedRowsExportData(null, rows)).toBeUndefined()
    expect(buildSelectedRowsExportData({ ...queryResult, error: 'bad' }, rows)).toBeUndefined()
    expect(buildSelectedRowsExportData(queryResult, [])).toBeUndefined()
    expect(buildSelectedRowsExportData(queryResult, rows, [column('id')])).toEqual({
      columns: ['id', 'name'],
      rows: [[1, 'A'], [2, null]],
    })
    expect(buildSelectedRowsExportData(queryResult, rows, [column('id', true)])).toEqual({
      columns: ['id', 'name'],
      rows: [[1, 'A'], [2, null]],
      autoIncrementColumns: ['id'],
    })
  })

  it('handles optional state and null result helpers', () => {
    expect(normalizeDataTabState()).toEqual({
      view: 'schema',
      globalSearch: '',
      whereFilter: '',
      appliedWhere: '',
      showFilterBar: false,
      limit: 1000,
    })
    expect(normalizeDataTabState({ whereFilter: 'id=1' }).showFilterBar).toBe(true)
    expect(normalizeDataTabState({ appliedWhere: 'id=2' }).showFilterBar).toBe(true)
    expect(normalizeDataTabState({ showFilterBar: false, whereFilter: 'x' }).showFilterBar).toBe(false)
    expect(shouldDebounceDataSearch('a', 'b', 'schema')).toBe(false)
    expect(shouldDebounceDataSearch('a', 'a', 'data')).toBe(false)
    expect(shouldDebounceDataSearch('a', 'b', 'data')).toBe(true)
    expect(filterDeletedRows(null, [], ['id'])).toBeNull()
  })

  it('recognizes executable comments and schema-changing statements', () => {
    expect(shouldUseSequentialExecute(['SET @x = 1'])).toBe(true)
    expect(shouldUseSequentialExecute(['USE app'])).toBe(true)
    expect(shouldUseSequentialExecute(['CALL proc()'])).toBe(true)
    expect(shouldUseSequentialExecute(['DELIMITER $$'])).toBe(true)
    expect(shouldUseSequentialExecute(['/*!40101 SET x=1 */'])).toBe(true)
    expect(shouldUseSequentialExecute(['INSERT INTO t VALUES (1)'])).toBe(false)
    expect(shouldUseSequentialExecute(['INSERT INTO t VALUES (1)', 'SELECT 1'])).toBe(true)
    expect(statementsChangeSchema(['SELECT 1', 'ALTER TABLE t ADD c INT'])).toBe(true)
    expect(statementsChangeSchema(['SELECT 1'])).toBe(false)
    expect(splitStatements('--')).toEqual(['--'])
    expect(shouldTryFastExecute([])).toBe(false)
  })
})

describe('TabContent import-time migrations', () => {
  it('migrates legacy word-wrap and editor-height keys', async () => {
    localStorage.setItem('queryWordWrap', 'false')
    localStorage.setItem('queryEditorHeight', '240')
    localStorage.removeItem('lagun-query-word-wrap')
    localStorage.removeItem('lagun-query-editor-height')
    vi.resetModules()
    await import('../../components/editor/TabContent')
    expect(localStorage.getItem('lagun-query-word-wrap')).toBe('false')
    expect(localStorage.getItem('lagun-query-editor-height')).toBe('240')
    expect(localStorage.getItem('queryWordWrap')).toBeNull()
    expect(localStorage.getItem('queryEditorHeight')).toBeNull()
  })

  it('leaves existing new keys alone and survives storage failure', async () => {
    localStorage.setItem('queryWordWrap', 'false')
    localStorage.setItem('lagun-query-word-wrap', 'true')
    localStorage.setItem('queryEditorHeight', '200')
    localStorage.setItem('lagun-query-editor-height', '300')
    vi.resetModules()
    await import('../../components/editor/TabContent')
    expect(localStorage.getItem('lagun-query-word-wrap')).toBe('true')
    expect(localStorage.getItem('lagun-query-editor-height')).toBe('300')

    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.resetModules()
    await expect(import('../../components/editor/TabContent')).resolves.toBeDefined()
    getItem.mockRestore()
  })

  it('falls back to the default fast-execute threshold when configured to zero', async () => {
    vi.stubEnv('VITE_LAGUN_BULK_WRITE_THRESHOLD', '0')
    vi.resetModules()
    const fresh = await import('../../components/editor/TabContent')
    expect(fresh.shouldTryFastExecute([])).toBe(false)
    vi.unstubAllEnvs()
  })
})
