import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as agGridReact from 'ag-grid-react'
import TabContent from '../../components/editor/TabContent'
import { useSchemaStore } from '../../store/schemaStore'
import type { Tab } from '../../types'
import {
  dataRequests,
  mockTableRows,
  resetDataRequests,
  resetMockTableRows,
} from '../handlers'

// The data tab delegates rendering (and therefore every user edit) to AG Grid,
// which does not run under jsdom — the repo's other grid tests substitute the
// manual mock in frontend/__mocks__/ag-grid-react.ts for the same reason. That
// mock captures the props ResultGrid passes to AgGridReact, so a test can fire
// the exact grid events a real edit commit / row selection produces. Everything
// downstream is real: ResultGrid's adapters, TabContent's handlers, the real
// DOM (toolbar buttons, confirm dialog, status line) and the request bodies the
// component serializes.
vi.mock('ag-grid-react')
vi.mock('ag-grid-community', () => ({ themeQuartz: { withParams: () => ({}) } }))

interface GridRow extends Record<string, unknown> {
  __ag_rowId: string
}

/** The AG Grid callback surface `ResultGrid` registers — injecting an event
 *  here is the same path a real edit commit / selection takes. */
interface MockGridProps {
  rowData: GridRow[]
  onCellValueChanged?: (params: {
    colDef: { field?: string | null }
    newValue: unknown
    oldValue: unknown
    rowIndex: number | null
    data: GridRow
  }) => void
  onSelectionChanged?: (e: { api: { getSelectedRows: () => GridRow[] } }) => void
}

const { __latestProps } = agGridReact as unknown as {
  __latestProps: { current: MockGridProps | null }
}

function gridProps(): MockGridProps {
  const props = __latestProps.current
  if (!props) throw new Error('ResultGrid has not rendered yet')
  return props
}

/** Commit a cell edit the way AG Grid reports one after the editor closes. */
function commitCellEdit(data: GridRow, column: string, oldValue: unknown, newValue: unknown) {
  const { onCellValueChanged } = gridProps()
  if (!onCellValueChanged) throw new Error('ResultGrid has no cell-edit handler')
  act(() => {
    onCellValueChanged({
      colDef: { field: column },
      newValue,
      oldValue,
      rowIndex: typeof data.__ag_rowIndex === 'number' ? data.__ag_rowIndex : null,
      data,
    })
  })
}

/** Select rows the way AG Grid reports a selection change. */
function selectRows(rows: GridRow[]) {
  const { onSelectionChanged } = gridProps()
  if (!onSelectionChanged) throw new Error('ResultGrid has no selection handler')
  act(() => {
    onSelectionChanged({ api: { getSelectedRows: () => rows } })
  })
}

function rowByName(name: unknown) {
  const row = gridProps().rowData.find(candidate => candidate.name === name)
  if (!row) throw new Error(`No grid row named ${String(name)}`)
  return row
}

const dataTab: Tab = {
  id: 'tab-users',
  label: 'users',
  type: 'table',
  sessionId: 'session-1',
  database: 'app_db',
  table: 'users',
  // Open straight into the data view; the schema view is not involved here.
  dataState: { view: 'data' },
}

async function renderLoadedDataTab() {
  render(<TabContent tab={dataTab} active />)
  await waitFor(() => expect(gridProps().rowData).toHaveLength(2))
  expect(dataRequests.query.length).toBeGreaterThan(0)
}

describe('TabContent data tab — row mutation wiring', () => {
  beforeEach(() => {
    resetDataRequests()
    resetMockTableRows()
    useSchemaStore.setState({ databases: {}, tables: {}, columns: {}, dbErrors: {} })
  })

  it('sends a staged cell edit as row-update and renders the edited value', async () => {
    await renderLoadedDataTab()

    commitCellEdit(rowByName('Alice'), 'name', 'Alice', 'Alicia')

    // The edit is staged, not sent: the toolbar offers the review flow.
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))

    await waitFor(() => expect(dataRequests.rowUpdate).toHaveLength(1))
    expect(dataRequests.rowUpdate[0]).toEqual({
      method: 'POST',
      url: '/api/v1/sessions/session-1/row-update',
      body: {
        database: 'app_db',
        table: 'users',
        primary_key: { id: 1 },
        updates: { name: 'Alicia' },
      },
    })

    // Server state took the write, and the grid the user sees shows it.
    expect(mockTableRows).toEqual([[1, 'Alicia'], [2, 'Bob']])
    await waitFor(() => expect(rowByName('Alicia').id).toBe(1))
    expect(screen.queryByRole('button', { name: /^Apply \(/ })).toBeNull()
  })

  it('sends a selected row as DELETE /rows and drops it from the grid', async () => {
    await renderLoadedDataTab()

    selectRows([rowByName('Bob')])

    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }))
    // Deletion is destructive, so it goes through the confirm dialog.
    await screen.findByText('Delete this row permanently? This action cannot be undone.')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Row' }))

    await waitFor(() => expect(dataRequests.rowDelete).toHaveLength(1))
    expect(dataRequests.rowDelete[0]).toEqual({
      method: 'DELETE',
      url: '/api/v1/sessions/session-1/rows',
      body: {
        database: 'app_db',
        table: 'users',
        primary_keys: [{ id: 2 }],
      },
    })

    expect(mockTableRows).toEqual([[1, 'Alice']])
    await screen.findByText('✓ Deleted 1 row')
    await waitFor(() => expect(gridProps().rowData.map(row => row.name)).toEqual(['Alice']))
  })

  it('sends an insert draft as row-insert and renders the new row', async () => {
    await renderLoadedDataTab()

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    const draft = gridProps().rowData.find(row => row.__lagun_insertDraft === true)
    expect(draft).toBeDefined()

    commitCellEdit(draft!, 'name', null, 'Carol')

    fireEvent.click(await screen.findByRole('button', { name: 'Apply (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply Changes' }))

    await waitFor(() => expect(dataRequests.rowInsert).toHaveLength(1))
    expect(dataRequests.rowInsert[0]).toEqual({
      method: 'POST',
      url: '/api/v1/sessions/session-1/row-insert',
      body: {
        database: 'app_db',
        table: 'users',
        values: { name: 'Carol' },
      },
    })

    await screen.findByText('✓ Inserted 1 row')
    await waitFor(() =>
      expect(gridProps().rowData.map(row => row.name)).toEqual(['Alice', 'Bob', 'Carol'])
    )
  })
})
