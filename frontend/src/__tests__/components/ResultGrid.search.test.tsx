import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ResultGrid from '../../components/editor/ResultGrid'
import * as agGridReact from 'ag-grid-react'
import type { QueryResult } from '../../types'

// The manual mock (__mocks__/ag-grid-react.ts) adds __calls / __latestProps
// exports that the real ag-grid-react types don't declare.
const __calls = (agGridReact as any).__calls as Record<string, any[]>
const __latestProps = (agGridReact as any).__latestProps as { current: any }

// ag-grid does not fully run under jsdom, so we use the manual mock in
// __mocks__/ag-grid-react.ts. It exposes __calls (recorded GridApi method
// calls) and __latestProps (the props most recently passed to AgGridReact, so
// tests can reach the columnDefs cellClassRules).
vi.mock('ag-grid-react')
vi.mock('ag-grid-community', () => ({ themeQuartz: { withParams: () => ({}) } }))

const baseResult: QueryResult = {
  columns: ['name', 'age'],
  rows: [
    ['Alice', 30],
    ['Bob', 25],
    ['Carol', 22],
  ],
  row_count: 3,
  exec_time_ms: 1,
}

function renderResultGrid(props: Partial<React.ComponentProps<typeof ResultGrid>> = {}) {
  return render(<ResultGrid result={baseResult} {...props} />)
}

// Wait for the debounced (100ms) match scan to populate findMatches and for the
// ref-mirroring effects to flush, so cellClassRules read the latest state.
async function waitForMatches() {
  await waitFor(() => expect(screen.getByText(/of/)).toBeInTheDocument())
}

describe('ResultGrid search wiring', () => {
  beforeEach(() => {
    Object.keys(__calls).forEach(k => delete __calls[k])
    __latestProps.current = null
  })

  it('renders without crashing given a small result set', () => {
    renderResultGrid()
    expect(screen.getByTestId('ag-grid')).toBeInTheDocument()
  })

  it('Ctrl+F (capture-phase window keydown) opens the find bar', () => {
    renderResultGrid()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })

  it('Esc after Ctrl+F closes the bar', () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('Ctrl+F reopens the bar after Esc', () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })

  it('Enter in the search input calls handleNext, advancing the match and flashing the cell', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    // query 'a' matches Alice (row 0) and Carol (row 2) -> 2 matches, current = 1
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(__calls.ensureNodeVisible?.length).toBeGreaterThan(0))
    expect(__calls.ensureColumnVisible?.length).toBeGreaterThan(0)
    expect(__calls.flashCells?.length).toBeGreaterThan(0)
    // advanced to match index 1 -> "2 of 2"
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('Shift+Enter calls handlePrev, moving back to the previous match', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    // advance forward first (0 -> 1)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('2 of 2')).toBeInTheDocument())

    // then go back (1 -> 0)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeInTheDocument())
    expect(__calls.ensureNodeVisible?.length).toBeGreaterThan(0)
    expect(__calls.flashCells?.length).toBeGreaterThan(0)
  })

  it('cellClassRules.find-match returns true for a cell whose lowercased value contains the query', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()

    const colDef = __latestProps.current.columnDefs[0]
    const findMatch = colDef.cellClassRules['find-match']
    expect(findMatch({ value: 'Alice' })).toBe(true)
    expect(findMatch({ value: 'Bob' })).toBe(false)
  })

  it('cellClassRules.find-match-current highlights ONLY the current match cell', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    // matches: [{rowIndex:0,colId:'name'},{rowIndex:2,colId:'name'}], current = 0

    const colDef = __latestProps.current.columnDefs[0]
    const isCurrent = colDef.cellClassRules['find-match-current']
    const nameCol = { getColId: () => 'name' }
    expect(isCurrent({ rowIndex: 0, column: nameCol })).toBe(true)
    expect(isCurrent({ rowIndex: 2, column: nameCol })).toBe(false)
    expect(isCurrent({ rowIndex: 1, column: nameCol })).toBe(false)
  })

  it('lagun:open-find custom event on window opens the bar (parity with Ctrl+F)', () => {
    renderResultGrid()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    fireEvent(window, new Event('lagun:open-find'))
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })
})
