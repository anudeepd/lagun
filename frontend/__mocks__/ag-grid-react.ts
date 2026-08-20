import React from 'react'

// Manual mock for ag-grid-react used by ResultGrid integration tests.
// ag-grid does not fully run under jsdom, so we substitute a lightweight
// component that captures the latest props (so tests can reach the
// columnDefs cellClassRules) and records calls to the fake GridApi methods
// that the ResultGrid wiring touches.

export const __calls: Record<string, any[]> = {}
export const __latestProps: { current: any } = { current: null }

function record(name: string) {
  return (...args: any[]) => {
    ;(__calls[name] ??= []).push(args)
  }
}

export const fakeApi = {
  ensureNodeVisible: record('ensureNodeVisible'),
  ensureColumnVisible: record('ensureColumnVisible'),
  flashCells: record('flashCells'),
  getEditingCells: () => [],
  refreshCells: record('refreshCells'),
  getSelectedRows: () => [],
  setColumnDefs: record('setColumnDefs'),
  getDisplayedRowAtIndex: () => ({ data: {} }),
  getColumnState: () => [],
  isAnyFilterPresent: () => false,
  forEachNodeAfterFilterAndSort: () => {},
  stopEditing: () => {},
  deselectAll: () => {},
  applyColumnState: () => {},
  forEachNode: () => {},
  startEditingCell: () => {},
  ensureIndexVisible: () => {},
  setFocusedCell: () => {},
  autoSizeColumn: () => {},
  setColumnWidth: () => {},
}

export const AgGridReact = React.forwardRef(function AgGridReact(props: any, _ref: any) {
  __latestProps.current = props
  React.useEffect(() => {
    props.onGridReady?.({ api: fakeApi })
  }, [])
  return React.createElement('div', { 'data-testid': 'ag-grid' })
})
