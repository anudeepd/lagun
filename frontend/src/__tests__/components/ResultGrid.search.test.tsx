import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ResultGrid from '../../components/editor/ResultGrid'
import * as agGridReact from 'ag-grid-react'
import { clipboardWrite } from '../../utils/clipboard'
import type { QueryResult } from '../../types'

// AppLayout keeps every tab mounted and marks the inactive panels `inert`, so a
// hidden ResultGrid must ignore the window-global key handling. jsdom does not
// implement `inert` event suppression, so these tests assert the component's own
// guard through rendered state, with the grid mounted inside a real element that
// carries the `inert` attribute (`rootRef.current.closest('[inert]')`).
vi.mock('../../utils/clipboard', () => ({ clipboardWrite: vi.fn(() => Promise.resolve()) }))
const mockClipboardWrite = vi.mocked(clipboardWrite)

// The manual mock (__mocks__/ag-grid-react.ts) adds __calls / __latestProps
// exports that the real ag-grid-react types don't declare.
interface AgGridTestHooks {
  __calls: Record<string, unknown[]>
  __latestProps: { current: { columnDefs?: Array<Record<string, unknown>> } | null }
}
const { __calls, __latestProps } = agGridReact as unknown as AgGridTestHooks

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

    const colDef = __latestProps.current!.columnDefs![0] as { cellClassRules: Record<string, (params: { value?: unknown; rowIndex?: number; column?: { getColId: () => string } }) => boolean> }
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

    const colDef = __latestProps.current!.columnDefs![0] as { cellClassRules: Record<string, (params: { value?: unknown; rowIndex?: number; column?: { getColId: () => string } }) => boolean> }
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

  it('Enter in an outside text input (e.g. WHERE filter) does NOT advance find matches', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    Object.keys(__calls).forEach(k => delete __calls[k])

    // Simulate the WHERE filter / global search input living outside the grid root.
    const outside = document.createElement('input')
    outside.type = 'text'
    document.body.appendChild(outside)
    outside.focus()
    try {
      fireEvent.keyDown(outside, { key: 'Enter' })
      // Still on the first match — the key belonged to the outside editor
      // (e.g. accepting filter autocomplete), not to find navigation.
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
      expect(__calls.ensureNodeVisible ?? []).toHaveLength(0)
    } finally {
      document.body.removeChild(outside)
    }
  })

  it('Enter in an outside CodeMirror editor does NOT advance find matches', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    Object.keys(__calls).forEach(k => delete __calls[k])

    const cmEditor = document.createElement('div')
    cmEditor.className = 'cm-editor'
    const cmContent = document.createElement('div')
    cmContent.className = 'cm-content'
    cmContent.setAttribute('contenteditable', 'true')
    cmEditor.appendChild(cmContent)
    document.body.appendChild(cmEditor)
    cmContent.focus()
    try {
      fireEvent.keyDown(cmContent, { key: 'Enter' })
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
      expect(__calls.ensureNodeVisible ?? []).toHaveLength(0)
    } finally {
      document.body.removeChild(cmEditor)
    }
  })

  it('Escape in an outside text input does NOT close the find bar', async () => {
    renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    expect(screen.getByRole('searchbox')).toBeInTheDocument()

    const outside = document.createElement('input')
    outside.type = 'text'
    document.body.appendChild(outside)
    outside.focus()
    try {
      fireEvent.keyDown(outside, { key: 'Escape' })
      // The outside editor owns Escape (dismiss autocomplete first).
      expect(screen.getByRole('searchbox')).toBeInTheDocument()
    } finally {
      document.body.removeChild(outside)
    }
  })

  it('Enter inside the grid root still advances matches (safety net)', async () => {
    const { container } = renderResultGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'a')
    await waitForMatches()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    const gridRoot = container.querySelector('.lagun-result-grid') as HTMLElement
    // Focus drifts off the find input onto the grid container after a scan.
    gridRoot.focus()
    fireEvent.keyDown(gridRoot, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('2 of 2')).toBeInTheDocument())
  })
})

describe('ResultGrid inside an inert subtree (a tab that is mounted but hidden)', () => {
  beforeEach(() => {
    Object.keys(__calls).forEach(k => delete __calls[k])
    __latestProps.current = null
    mockClipboardWrite.mockClear()
  })

  it('Ctrl+F opens the find bar only in the reachable grid, not in the inert sibling', () => {
    const { container } = render(
      <>
        <div id="active-panel"><ResultGrid result={baseResult} /></div>
        <div id="hidden-panel"><ResultGrid result={baseResult} /></div>
      </>
    )
    // The grid's own guard reads the attribute off the DOM, so the wrapper must
    // carry a real `inert` attribute — jsdom would otherwise route the event
    // into both grids regardless of inertness.
    container.querySelector('#hidden-panel')!.setAttribute('inert', '')

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    const liveRoot = container.querySelector('#active-panel .lagun-result-grid')!
    const hiddenRoot = container.querySelector('#hidden-panel .lagun-result-grid')!
    expect(liveRoot.querySelector('[role="search"]')).not.toBeNull()
    expect(hiddenRoot.querySelector('[role="search"]')).toBeNull()
    // The window-level open-find event (parity with Ctrl+F) is gated the same way.
    fireEvent(window, new Event('lagun:open-find'))
    expect(liveRoot.querySelector('[role="search"]')).not.toBeNull()
    expect(hiddenRoot.querySelector('[role="search"]')).toBeNull()
  })

  it('closes an open find bar when the tab turns inert, so activating it later shows no stale bar', async () => {
    const { container } = render(<div id="panel"><ResultGrid result={baseResult} /></div>)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()

    const panel = container.querySelector('#panel') as HTMLElement
    panel.setAttribute('inert', '')
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument())

    // Switching back to the tab must not resurrect the bar the user opened
    // while looking at the other tab.
    panel.removeAttribute('inert')
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('Enter from document.body does not step matches in an inert grid with its find bar open', async () => {
    // The effect that closes the bar on inertness is neutralised here so the
    // navigation guard is exercised on its own: the bar stays open while the
    // panel is inert, which is the window the guard exists for.
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return [] } })
    try {
      const { container } = render(<div id="panel"><ResultGrid result={baseResult} /></div>)
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      await userEvent.type(screen.getByRole('searchbox'), 'a')
      await waitForMatches()
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
      Object.keys(__calls).forEach(k => delete __calls[k])

      container.querySelector('#panel')!.setAttribute('inert', '')
      expect(screen.getByRole('searchbox')).toBeInTheDocument()

      fireEvent.keyDown(document.body, { key: 'Enter' })

      expect(__calls.ensureNodeVisible ?? []).toHaveLength(0)
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Ctrl+C copies for the reachable grid but not from inside an inert subtree', () => {
    const { container } = renderResultGrid()
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    const props = __latestProps.current as { onCellFocused: (e: unknown) => void }
    props.onCellFocused({
      rowIndex: 0,
      column: 'name',
      api: { getDisplayedRowAtIndex: () => ({ data: { name: 'Alice' } }) },
    })
    root.focus()

    fireEvent.keyDown(root, { key: 'c', ctrlKey: true })
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1)

    container.setAttribute('inert', '')
    fireEvent.keyDown(root, { key: 'c', ctrlKey: true })
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1)
  })
})
