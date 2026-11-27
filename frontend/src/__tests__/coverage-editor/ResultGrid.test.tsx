import { createRef, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as agGridReact from 'ag-grid-react'
import ResultGrid, {
  buildResultGridRowData,
  canSetCellToNull,
  focusTextareaAtEnd,
  formatResultGridCellValue,
  placeInlineEditorCaretAtEnd,
  type ResultGridHandle,
} from '../../components/editor/ResultGrid'
import { clipboardWrite } from '../../utils/clipboard'
import type { ColumnInfo, QueryResult } from '../../types'

vi.mock('../../utils/clipboard', () => ({ clipboardWrite: vi.fn(() => Promise.resolve()) }))
const mockClipboardWrite = vi.mocked(clipboardWrite)

vi.mock('ag-grid-react')
vi.mock('ag-grid-community', async (importOriginal) => ({
  ...await importOriginal<typeof import('ag-grid-community')>(),
  themeQuartz: { withParams: () => ({}) },
}))

interface GridProps {
  rowData: Array<Record<string, unknown>>
  columnDefs: Array<Record<string, any>>
  onGridReady?: (event: { api: Record<string, any> }) => void
  onCellClicked?: (event: Record<string, any>) => void
  onCellFocused?: (event: Record<string, any>) => void
  onCellDoubleClicked?: (event: Record<string, any>) => void
  onCellValueChanged?: (event: Record<string, any>) => void
  onCellEditingStarted?: () => void
  onSelectionChanged?: (event: { api: { getSelectedRows: () => Record<string, unknown>[] } }) => void
  onRowClicked?: (event: Record<string, any>) => void
  onColumnHeaderClicked?: (event: Record<string, any>) => void
  onColumnResized?: (event: Record<string, any>) => void
  onCellContextMenu?: (event: Record<string, any>) => void
  onBodyScroll?: () => void
  [key: string]: any
}

const hooks = agGridReact as unknown as {
  __calls: Record<string, unknown[][]>
  __latestProps: { current: GridProps | null }
  fakeApi: Record<string, any>
}
const { __calls, __latestProps, fakeApi } = hooks

beforeEach(() => {
  Object.keys(__calls).forEach(key => delete __calls[key])
  __latestProps.current = null
  mockClipboardWrite.mockClear()
})

const result: QueryResult = {
  columns: ['id', 'name', 'payload'],
  rows: [
    [1, 'Alice', 'x'],
    [2, 'Bob', null],
  ],
  row_count: 2,
  exec_time_ms: 7,
}

function gridProps(): GridProps {
  if (!__latestProps.current) throw new Error('grid not rendered')
  return __latestProps.current
}

function column(
  name: string,
  overrides: Partial<ColumnInfo> = {},
): ColumnInfo {
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

function renderGrid(
  props: Partial<React.ComponentProps<typeof ResultGrid>> = {},
  ref?: React.Ref<ResultGridHandle>,
) {
  return render(<ResultGrid ref={ref} result={result} {...props} />)
}

function installApi(api: Record<string, any>) {
  act(() => {
    gridProps().onGridReady?.({ api })
  })
}

function rowNode(data: Record<string, unknown> | undefined, selected = false, rowIndex: number | null = 0) {
  return {
    data,
    rowIndex,
    isSelected: () => selected,
    setSelected: vi.fn(),
  }
}

describe('ResultGrid value and DOM helpers', () => {
  it('formats undefined, NULL, and ordinary values', () => {
    expect(formatResultGridCellValue(undefined)).toBe('')
    expect(formatResultGridCellValue(null)).toBe('NULL')
    expect(formatResultGridCellValue(0)).toBe('0')
    expect(canSetCellToNull(undefined, true)).toBe(false)
    expect(canSetCellToNull(column('id', { is_nullable: false }), true)).toBe(false)
  })

  it('safely handles missing textareas and non-text inline editors', () => {
    focusTextareaAtEnd(null)
    placeInlineEditorCaretAtEnd(null)

    const root = document.createElement('div')
    const numberInput = document.createElement('input')
    numberInput.type = 'number'
    numberInput.className = 'ag-cell-inline-editing'
    root.append(numberInput)
    expect(() => placeInlineEditorCaretAtEnd(root)).not.toThrow()
    expect(() => placeInlineEditorCaretAtEnd(document.createElement('div'))).not.toThrow()
  })
})

describe('buildResultGridRowData behavior', () => {
  it('overlays pending edits and supports caller-selected row identity', () => {
    const base = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
    const pending = new Map([
      [base[0].__ag_rowId as string, { original: {}, changes: { name: 'Alicia' } }],
    ])
    const edited = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      pendingChanges: pending,
    })
    expect(edited[0].name).toBe('Alicia')
    expect(edited[1].name).toBe('Bob')

    const indexed = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      includeRowIndexInId: true,
    })
    expect(indexed[0].__ag_rowId).toMatch(/^row:/)
  })

  it('inserts anchored drafts in order and appends unanchored or missing-anchor drafts', () => {
    const base = buildResultGridRowData({ result, primaryKeyColumns: ['id'] })
    const draftId = 'draft-anchored'
    const missingAnchorId = 'draft-missing'
    const noAnchorMapId = 'draft-no-anchor-map'
    const rows = buildResultGridRowData({
      result,
      primaryKeyColumns: ['id'],
      insertDrafts: new Map([
        [draftId, { id: 3, name: 'Carol' }],
        [missingAnchorId, { id: 4 }],
        [noAnchorMapId, { id: 5 }],
      ]),
      insertDraftAnchors: new Map([
        [draftId, { afterRowId: base[0].__ag_rowId as string }],
        [missingAnchorId, { afterRowId: 'not-present' }],
      ]),
    })

    expect(rows.map(row => row.id)).toEqual([1, 3, 2, 5, 4])
    expect(rows[1]).toMatchObject({ name: 'Carol', __lagun_insertDraft: true })
    expect(rows[3]).toMatchObject({ name: null, __lagun_insertDraft: true })
    expect(rows[4]).toMatchObject({ name: null, __lagun_insertDraft: true })
  })
})

describe('ResultGrid column definitions', () => {
  it('styles values, hidden columns, pending cells, drafts, and wide content', () => {
    const wideResult: QueryResult = {
      columns: ['id', 'name', 'payload'],
      rows: [[1, null, 'x'.repeat(100)]],
      row_count: 1,
      exec_time_ms: 1,
    }
    const ref = createRef<ResultGridHandle>()
    renderGrid(
      {
        result: wideResult,
        editable: true,
        hiddenColumns: new Set(['id']),
        pendingChanges: new Map(),
        insertDrafts: new Map([['draft', { id: 2 }]]),
      },
      ref,
    )
    const props = gridProps()
    const [idDef, nameDef, payloadDef] = props.columnDefs

    expect(idDef.hide).toBe(true)
    expect(idDef.flex).toBe(1)
    expect(payloadDef.width).toBeGreaterThan(480)
    expect(payloadDef.valueFormatter({ value: null })).toBe('NULL')
    expect(nameDef.cellStyle({ value: null })).toMatchObject({ fontStyle: 'italic' })
    expect(nameDef.cellStyle({ value: 'Alice' })).not.toHaveProperty('fontStyle')

    const firstRowId = props.rowData[0].__ag_rowId as string
    const pending = new Map([
      [firstRowId, { original: {}, changes: { name: 'Alicia' } }],
    ])
    renderGrid({
      result: wideResult,
      pendingChanges: pending,
      insertDrafts: new Map([['draft', { id: 2 }]]),
    })
    const pendingProps = gridProps()
    const [pendingIdDef, pendingNameDef] = pendingProps.columnDefs
    expect(pendingNameDef.cellClassRules['cell-pending']({ data: pendingProps.rowData[0] })).toBe(true)
    expect(pendingIdDef.cellClassRules['cell-pending']({ data: pendingProps.rowData[0] })).toBe(false)
    const draft = pendingProps.rowData.find(row => row.__lagun_insertDraft)
    expect(pendingNameDef.cellClassRules['cell-insert-draft']({ data: draft })).toBe(true)
    expect(pendingNameDef.cellClassRules['cell-insert-draft']({ data: pendingProps.rowData[0] })).toBe(false)
  })

  it('renders plain and highlighted cell content', async () => {
    renderGrid()
    const nameDef = gridProps().columnDefs[1]
    expect(nameDef.cellRenderer({ value: 'Alice' })).toBe('Alice')

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'al' } })
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeInTheDocument())

    const rendered = nameDef.cellRenderer({ value: 'Alice' }) as ReactNode
    const view = render(<>{rendered}</>)
    expect(view.container).toHaveTextContent('Alice')
    expect(view.container.querySelectorAll('mark')).toHaveLength(1)
    expect(nameDef.cellRenderer({ value: 'Bob' })).toBe('Bob')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeInTheDocument())
    const markAll = gridProps().columnDefs[1].cellRenderer({ value: 'aAa' }) as ReactNode
    const multi = render(<>{markAll}</>)
    expect(multi.container.querySelectorAll('mark')).toHaveLength(3)

    const currentName = gridProps().columnDefs[1].cellClassRules['find-match-current']
    expect(currentName({ rowIndex: 0, column: { getColId: () => 'name' } })).toBe(true)
    expect(currentName({ rowIndex: 1, column: { getColId: () => 'name' } })).toBe(false)
    expect(currentName({ rowIndex: 0, column: { getColId: () => 'id' } })).toBe(false)
  })
})

describe('ResultGrid imperative handle', () => {
  it('exports filtered and selected data with hidden columns and auto-increment metadata', () => {
    const ref = createRef<ResultGridHandle>()
    const selected = { __ag_rowId: 'selected', name: 'Bob', id: 2, payload: 'y' }
    const selectedHiddenByFilter = { __ag_rowId: 'hidden', name: 'Carol', id: 3 }
    const api = {
      isAnyFilterPresent: () => true,
      getColumnState: () => [{ sort: 'asc' }],
      forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => {
        callback({ data: selected, isSelected: () => true })
        callback({ data: undefined, isSelected: () => false })
      },
      getSelectedNodes: () => [
        { data: selected, isSelected: () => true },
        { data: selectedHiddenByFilter, isSelected: () => true },
        { data: undefined, isSelected: () => false },
      ],
      ensureIndexVisible: vi.fn(),
      stopEditing: vi.fn(),
      deselectAll: vi.fn(),
      applyColumnState: vi.fn(),
    }
    renderGrid(
      {
        ref,
        hiddenColumns: new Set(['payload']),
        columns: [column('id', { is_auto_increment: true }), column('name')],
        onSortActiveChange: vi.fn(),
      },
    )
    installApi(api)

    expect(ref.current?.isAnyFilterPresent()).toBe(true)
    expect(ref.current?.isAnySortPresent()).toBe(true)
    expect(ref.current?.getFilteredData()).toEqual({
      columns: ['id', 'name'],
      rows: [[2, 'Bob']],
      autoIncrementColumns: ['id'],
    })
    expect(ref.current?.getSelectedData()).toEqual({
      columns: ['id', 'name'],
      rows: [[2, 'Bob'], [3, 'Carol']],
      autoIncrementColumns: ['id'],
    })
    ref.current?.scrollToTop()
    ref.current?.stopEditing()
    ref.current?.deselectAll()
    ref.current?.clearSort()
    expect(api.ensureIndexVisible).toHaveBeenCalledWith(0, 'top')
    expect(api.stopEditing).toHaveBeenCalledOnce()
    expect(api.deselectAll).toHaveBeenCalledOnce()
    expect(api.applyColumnState).toHaveBeenCalledWith({ defaultState: { sort: null } })
  })

  it('reports no filter or sort and tolerates missing rows in export walkers', () => {
    const ref = createRef<ResultGridHandle>()
    const api = {
      isAnyFilterPresent: () => false,
      getColumnState: () => [{ sort: 'asc' }, { sort: null }],
      forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => callback({ data: null, isSelected: () => false }),
      getSelectedNodes: () => [{ data: { __ag_rowId: 'one', id: 1 }, isSelected: () => true }],
      ensureIndexVisible: vi.fn(),
      stopEditing: vi.fn(),
      deselectAll: vi.fn(),
      applyColumnState: vi.fn(),
    }
    renderGrid({ ref })
    installApi(api)
    expect(ref.current?.isAnyFilterPresent()).toBe(false)
    expect(ref.current?.isAnySortPresent()).toBe(true)
    expect(ref.current?.getFilteredData().rows).toEqual([])
    expect(ref.current?.getSelectedData().rows).toEqual([[1, null, null]])
  })
})

describe('ResultGrid cell and keyboard interactions', () => {
  it('tracks clicked and focused cells and reports edits and selections', () => {
    const onCellEdit = vi.fn()
    const onSelectionChange = vi.fn()
    renderGrid({ editable: true, onCellEdit, onSelectionChange, selectable: true })
    const props = gridProps()
    const data = props.rowData[0]

    act(() => {
      props.onCellClicked?.({
        event: { target: document.createElement('div') },
        node: rowNode(data),
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data,
      })
    })
    act(() => {
      props.onCellValueChanged?.({ colDef: { field: 'name' }, newValue: 'Alicia', oldValue: 'Alice', rowIndex: 0, data })
    })
    expect(onCellEdit).toHaveBeenCalledWith({
      column: 'name',
      newValue: 'Alicia',
      oldValue: 'Alice',
      data,
    })

    act(() => {
      props.onCellValueChanged?.({ colDef: {}, newValue: 'ignored', oldValue: 'x', rowIndex: 0, data })
    })
    expect(onCellEdit).toHaveBeenCalledTimes(1)

    act(() => {
      props.onCellFocused?.({
        rowIndex: 1,
        column: { getColId: () => 'name' },
        api: { getDisplayedRowAtIndex: () => ({ data: props.rowData[1] }) },
      })
      props.onCellFocused?.({
        rowIndex: null,
        column: 'name',
        api: { getDisplayedRowAtIndex: () => ({ data: props.rowData[0] }) },
      })
      props.onCellFocused?.({
        rowIndex: 0,
        column: null,
        api: { getDisplayedRowAtIndex: () => ({ data: props.rowData[0] }) },
      })
      props.onCellFocused?.({
        rowIndex: 0,
        column: 'name',
        api: { getDisplayedRowAtIndex: () => undefined },
      })
    })

    act(() => {
      props.onSelectionChanged?.({ api: { getSelectedRows: () => [props.rowData[0]] } })
    })
    expect(onSelectionChange).toHaveBeenCalledWith([props.rowData[0]])

    act(() => {
      props.onCellClicked?.({
        event: { target: {} },
        node: rowNode(data),
        colDef: {},
        rowIndex: 0,
        value: 'Alice',
        data,
      })
    })
    expect(onCellEdit).toHaveBeenCalledTimes(1)
  })

  it('opens the right cell surface for double clicks and applies or cancels edits', async () => {
    const onCellEdit = vi.fn()
    renderGrid({ editable: true, onCellEdit })
    const props = gridProps()
    const data = props.rowData[0]

    act(() => {
      props.onCellDoubleClicked?.({ colDef: {}, rowIndex: 0, value: 'x', data, api: {} })
      props.onCellDoubleClicked?.({ colDef: { field: 'name' }, rowIndex: null, value: 'x', data, api: {} })
      props.onCellDoubleClicked?.({ colDef: { field: 'name' }, rowIndex: 0, value: 'x', data: undefined, api: {} })
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const nullOverflowCell = document.createElement('div')
    nullOverflowCell.className = 'ag-cell'
    const nullOverflowContent = document.createElement('div')
    nullOverflowContent.className = 'ag-cell-value'
    Object.defineProperty(nullOverflowContent, 'clientWidth', { configurable: true, value: 100 })
    Object.defineProperty(nullOverflowContent, 'scrollWidth', { configurable: true, value: 220 })
    nullOverflowCell.append(nullOverflowContent)
    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'payload' },
        rowIndex: 0,
        value: null,
        data: { payload: null },
        event: { target: nullOverflowCell },
        api: {},
      })
    })
    const editDialog = await screen.findByRole('dialog', { name: 'Edit cell' })
    expect(within(editDialog).getByText('NULL')).toBeInTheDocument()
    fireEvent.click(within(editDialog).getByRole('button', { name: 'Apply' }))
    expect(onCellEdit).toHaveBeenCalledWith({
      column: 'payload',
      newValue: null,
      oldValue: null,
      data: { payload: null },
    })

    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: nullOverflowCell },
        api: {},
      })
    })
    const valueDialog = await screen.findByRole('dialog', { name: 'Edit cell' })
    fireEvent.change(within(valueDialog).getByRole('textbox', { name: 'Edit name' }), {
      target: { value: 'Alicia' },
    })
    fireEvent.click(within(valueDialog).getByRole('button', { name: 'Apply' }))
    expect(onCellEdit).toHaveBeenLastCalledWith({
      column: 'name',
      newValue: 'Alicia',
      oldValue: 'Alice',
      data: { name: 'Alice' },
    })

    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: nullOverflowCell },
        api: {},
      })
    })
    const cancelDialog = await screen.findByRole('dialog', { name: 'Edit cell' })
    fireEvent.click(within(cancelDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument())

    act(() => {
      props.onCellEditingStarted?.()
    })
  })

  it('uses the large editor for newlines and overflowing DOM cells, otherwise starts inline editing', () => {
    renderGrid({ editable: true })
    const props = gridProps()
    const startEditingCell = vi.fn()

    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'payload' },
        rowIndex: 0,
        value: 'line 1\nline 2',
        data: { payload: 'line 1\nline 2' },
        api: { startEditingCell },
      })
    })
    expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const cell = document.createElement('div')
    cell.className = 'ag-cell'
    const content = document.createElement('div')
    content.className = 'ag-cell-value'
    Object.defineProperty(content, 'clientWidth', { configurable: true, value: 100 })
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 220 })
    cell.append(content)
    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: cell },
        api: { startEditingCell },
      })
    })
    expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const narrowCell = document.createElement('div')
    narrowCell.className = 'ag-cell'
    const narrowContent = document.createElement('div')
    narrowContent.className = 'ag-cell-value'
    Object.defineProperty(narrowContent, 'clientWidth', { configurable: true, value: 100 })
    Object.defineProperty(narrowContent, 'scrollWidth', { configurable: true, value: 100 })
    narrowCell.append(narrowContent)
    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: narrowCell },
        api: { startEditingCell },
      })
    })
    expect(startEditingCell).toHaveBeenCalledWith({ rowIndex: 0, colKey: 'name', key: 'F2' })

    const outsideCell = document.createElement('div')
    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: outsideCell },
        api: { startEditingCell },
      })
    })
    expect(startEditingCell).toHaveBeenCalledTimes(2)

    act(() => {
      props.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { name: 'Alice' },
        event: { target: null },
        api: { startEditingCell },
      })
    })
    expect(startEditingCell).toHaveBeenCalledTimes(3)
  })

  it('opens a read-only viewer and copies its value', async () => {
    renderGrid()
    act(() => {
      gridProps().onCellDoubleClicked?.({
        colDef: { field: 'payload' },
        rowIndex: 1,
        value: null,
        data: { payload: null },
        api: {},
      })
    })
    const dialog = await screen.findByRole('dialog', { name: 'View cell' })
    expect(within(dialog).getAllByText('NULL').length).toBeGreaterThan(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }))
    expect(mockClipboardWrite).toHaveBeenCalledWith('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
  })

  it('handles clipboard, editor, and large-view keyboard shortcuts', async () => {
    const onCellEdit = vi.fn()
    const { container } = renderGrid({ editable: true, onCellEdit })
    const props = gridProps()
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    act(() => {
      props.onCellClicked?.({
        event: { target: document.createElement('div') },
        node: rowNode(props.rowData[0]),
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: props.rowData[0],
      })
    })
    root.focus()

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    expect(mockClipboardWrite).toHaveBeenCalledWith('Alice')
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true, ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true, altKey: true })
    expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument()

    const input = document.createElement('input')
    root.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument()
  })

  it('opens the read-only surface from the keyboard and ignores edits in progress', () => {
    const { container } = renderGrid()
    const props = gridProps()
    const root = container.querySelector('.lagun-result-grid') as HTMLElement

    root.focus()
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    act(() => {
      props.onCellClicked?.({
        event: { target: document.createElement('div') },
        node: rowNode(props.rowData[0]),
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: props.rowData[0],
      })
    })
    root.focus()
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'View cell' })).toBeInTheDocument()

    installApi({
      ...fakeApi,
      getEditingCells: () => [{ rowIndex: 0, column: { getColId: () => 'name' } }],
    })
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true })
    expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument()
  })

  it('copies a NULL active cell and ignores non-Enter shifted keys', () => {
    const { container } = renderGrid()
    const props = gridProps()
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    act(() => {
      props.onCellClicked?.({
        event: { target: document.createElement('div') },
        node: rowNode(props.rowData[1]),
        colDef: { field: 'payload' },
        rowIndex: 1,
        value: null,
        data: props.rowData[1],
      })
    })
    root.focus()
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    expect(mockClipboardWrite).toHaveBeenLastCalledWith('')
    fireEvent.keyDown(window, { key: 'x', shiftKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('navigates find results defensively when the grid has no node and covers nav guards', async () => {
    const { container } = renderGrid()
    const props = gridProps()
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'Alice' } })
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeInTheDocument())
    installApi({
      ...fakeApi,
      getDisplayedRowAtIndex: () => undefined,
      ensureNodeVisible: vi.fn(),
      ensureColumnVisible: vi.fn(),
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    document.body.focus()
    fireEvent.keyDown(window, { key: 'Enter' })
    const outside = document.createElement('div')
    document.body.append(outside)
    outside.tabIndex = 0
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Enter' })

    const button = document.createElement('button')
    root.append(button)
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })

    const codeMirrorShell = document.createElement('div')
    codeMirrorShell.className = 'cm-editor'
    codeMirrorShell.tabIndex = 0
    root.append(codeMirrorShell)
    codeMirrorShell.focus()
    fireEvent.keyDown(codeMirrorShell, { key: 'Enter' })

    installApi({
      ...fakeApi,
      getEditingCells: () => [{ rowIndex: 0 }],
    })
    fireEvent.keyDown(window, { key: 'Enter' })

    installApi({
      ...fakeApi,
      getEditingCells: () => ({ length: undefined }),
    })
    root.focus()
    fireEvent.keyDown(root, { key: 'Enter' })
    fireEvent.keyDown(root, { key: 'x' })
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))

    act(() => {
      props.onCellClicked?.({
        event: { target: document.createElement('div') },
        node: rowNode(props.rowData[0]),
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: props.rowData[0],
      })
    })
    installApi({ ...fakeApi, getEditingCells: () => ({ length: undefined }) })
    fireEvent.keyDown(root, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'View cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    outside.remove()
  })

  it('keeps the find bar open for unrelated inert mutations', async () => {
    renderGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    const unrelated = document.createElement('div')
    document.body.append(unrelated)
    unrelated.setAttribute('inert', '')
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeInTheDocument())
    unrelated.remove()
  })
})

describe('ResultGrid row and header interactions', () => {
  it('sets selection anchors and applies Shift ranges', () => {
    renderGrid({ selectable: true })
    const props = gridProps()
    const nodes = props.rowData.map((data, rowIndex) => rowNode(data, false, rowIndex))
    const api = {
      deselectAll: vi.fn(),
      forEachNode: (callback: (node: any) => void) => nodes.forEach(callback),
    }

    act(() => {
      props.onRowClicked?.({ rowIndex: 0, event: { shiftKey: false }, api })
      props.onRowClicked?.({ rowIndex: 1, event: { shiftKey: true }, api })
    })
    expect(api.deselectAll).toHaveBeenCalledOnce()
    expect(nodes[0].setSelected).toHaveBeenCalledWith(true)
    expect(nodes[1].setSelected).toHaveBeenCalledWith(true)

    act(() => {
      props.onRowClicked?.({ rowIndex: null, event: null, api })
      props.onRowClicked?.({ rowIndex: null, event: { shiftKey: true }, api })
    })
    expect(nodes[0].setSelected).toHaveBeenCalledWith(true)
  })

  it('toggles auto-size and flex for header clicks and reacts to the end of a resize', () => {
    renderGrid()
    const props = gridProps()
    const api = {
      autoSizeColumns: vi.fn(),
      setColumnWidths: vi.fn(),
      applyColumnState: vi.fn(),
    }
    const column = {
      getColId: () => 'name',
      getActualWidth: () => 520,
    }
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    now.mockReturnValue(1100)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    expect(api.autoSizeColumns).toHaveBeenCalledWith(['name'])
    expect(api.setColumnWidths).toHaveBeenCalledWith([{ key: 'name', newWidth: 400 }])

    act(() => props.onColumnHeaderClicked?.({ column: {}, api }))
    now.mockReturnValue(2000)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    now.mockReturnValue(2100)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    expect(api.applyColumnState).toHaveBeenCalledWith({ state: [{ colId: 'name', flex: 1 }] })

    act(() => props.onColumnResized?.({ finished: false, source: 'uiColumnDragged', column }))
    act(() => props.onColumnResized?.({ finished: true, source: 'api', column }))
    act(() => props.onColumnResized?.({ finished: true, source: 'uiColumnDragged', column: null }))
    act(() => props.onColumnResized?.({ finished: true, source: 'uiColumnDragged', column }))
    now.mockReturnValue(3000)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    now.mockReturnValue(3100)
    act(() => props.onColumnHeaderClicked?.({ column, api }))
    expect(api.autoSizeColumns).toHaveBeenCalledTimes(2)

    const narrow = { getColId: () => 'payload', getActualWidth: () => 200 }
    const widthCallsBeforeNarrow = api.setColumnWidths.mock.calls.length
    now.mockReturnValue(4000)
    act(() => props.onColumnHeaderClicked?.({ column: narrow, api }))
    now.mockReturnValue(4100)
    act(() => props.onColumnHeaderClicked?.({ column: narrow, api }))
    expect(api.setColumnWidths).toHaveBeenCalledTimes(widthCallsBeforeNarrow)
    now.mockRestore()
  })
})

function openCellMenu(options: {
  data?: Record<string, unknown>
  columnName?: string
  value?: unknown
  selectedRows?: Record<string, unknown>[]
}) {
  const props = gridProps()
  const preventDefault = vi.fn()
  act(() => {
    props.onCellContextMenu?.({
      event: { preventDefault, clientX: 12, clientY: 18 },
      api: { getSelectedRows: () => options.selectedRows ?? [] },
      colDef: { field: options.columnName ?? 'name' },
      value: options.value ?? 'Alice',
      data: options.data ?? props.rowData[0],
    })
  })
  return preventDefault
}

describe('ResultGrid context menus', () => {
  it('ignores a missing native event and copies a cell or the display row', async () => {
    renderGrid()
    const props = gridProps()
    act(() => {
      props.onCellContextMenu?.({
        event: null,
        api: { getSelectedRows: () => [] },
        colDef: { field: 'name' },
        value: 'Alice',
        data: props.rowData[0],
      })
    })
    expect(screen.queryByRole('menu', { name: 'Grid actions' })).not.toBeInTheDocument()

    const prevented = openCellMenu({})
    expect(prevented).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu', { name: 'Grid actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy cell/ }))
    expect(mockClipboardWrite).toHaveBeenCalledWith('Alice')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    openCellMenu({ data: { ...props.rowData[0], ignored: 'x' } })
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy row as JSON/ }))
    const copied = JSON.parse(mockClipboardWrite.mock.calls.at(-1)![0] as string)
    expect(copied).toMatchObject({ id: 1, name: 'Alice' })
    expect(copied).not.toHaveProperty('__ag_rowId')
  })

  it('does not open the large editor for a synthetic row-index column', async () => {
    renderGrid({ editable: true })
    openCellMenu({ columnName: '__rowIndex' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit cell/ }))
    expect(screen.queryByRole('dialog', { name: 'Edit cell' })).not.toBeInTheDocument()
  })

  it('opens the full value viewer and the large editor from menu items', async () => {
    renderGrid({ editable: true, onCellEdit: vi.fn() })
    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /View full value/ }))
    expect(await screen.findByRole('dialog', { name: 'View cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'View cell' })).not.toBeInTheDocument())

    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit cell/ }))
    expect(await screen.findByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('sets nullable cells and date cells through menu actions', async () => {
    const onCellEdit = vi.fn()
    const { unmount } = renderGrid({
      editable: true,
      onCellEdit,
      columns: [
        column('name', { is_nullable: true }),
        column('created', { data_type: 'date' }),
        column('clock', { data_type: 'time' }),
        column('stamp', { data_type: 'datetime' }),
      ],
    })
    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /Set to NULL/ }))
    expect(onCellEdit).toHaveBeenLastCalledWith({
      column: 'name',
      newValue: null,
      oldValue: 'Alice',
      data: gridProps().rowData[0],
    })

    openCellMenu({ columnName: 'created', value: '2020-01-01' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Set to NOW/ }))
    expect(onCellEdit.mock.calls.at(-1)![0].newValue).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    openCellMenu({ columnName: 'clock', value: '10:00:00' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Set to NOW/ }))
    expect(onCellEdit.mock.calls.at(-1)![0].newValue).toMatch(/^\d{2}:\d{2}:\d{2}$/)

    openCellMenu({ columnName: 'stamp', value: '2020-01-01 10:00:00' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Set to NOW/ }))
    expect(onCellEdit.mock.calls.at(-1)![0].newValue).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    unmount()
  })

  it('duplicates rows with and without keys and deletes one or many selected rows', () => {
    const onDuplicateRow = vi.fn()
    const onDeleteRows = vi.fn()
    renderGrid({
      editable: true,
      primaryKeyColumns: ['id'],
      onDuplicateRow,
      onDeleteRows,
    })
    const props = gridProps()

    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate row with keys/ }))
    expect(onDuplicateRow).toHaveBeenLastCalledWith(props.rowData[0], 'withKeys')

    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate row without keys/ }))
    expect(onDuplicateRow).toHaveBeenLastCalledWith(props.rowData[0], 'withoutKeys')

    openCellMenu({})
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete row/ }))
    expect(onDeleteRows).toHaveBeenLastCalledWith([props.rowData[0]])

    openCellMenu({ selectedRows: props.rowData })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2 rows' }))
    expect(onDeleteRows).toHaveBeenLastCalledWith(props.rowData)

    openCellMenu({ selectedRows: [{ __ag_rowId: 'missing' }] })
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete row/ }))
    expect(onDeleteRows).toHaveBeenLastCalledWith([props.rowData[0]])
  })

  it('keeps insert drafts out of delete/duplicate and allows NULL for auto-increment drafts', () => {
    const onCellEdit = vi.fn()
    const onDeleteRows = vi.fn()
    const onDuplicateRow = vi.fn()
    renderGrid({
      editable: true,
      primaryKeyColumns: ['id'],
      columns: [column('name', { is_nullable: false, is_auto_increment: true })],
      onCellEdit,
      onDeleteRows,
      onDuplicateRow,
    })
    const props = gridProps()
    const draft = { __ag_rowId: 'draft', __lagun_insertDraft: true, name: null }
    openCellMenu({ data: draft, columnName: 'name', value: null })
    expect(screen.queryByRole('menuitem', { name: /Delete row/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Duplicate row/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /Edit cell/ }))
    expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    openCellMenu({ data: draft, columnName: 'name', value: null })
    fireEvent.click(screen.getByRole('menuitem', { name: /Set to NULL/ }))
    expect(onCellEdit).toHaveBeenCalledWith({
      column: 'name',
      newValue: null,
      oldValue: null,
      data: draft,
    })
    expect(props.rowData.some(row => row.__lagun_insertDraft)).toBe(false)
  })

  it('opens an empty-row menu and inserts through it', async () => {
    const onCreateEmptyRow = vi.fn()
    const { container } = renderGrid({ editable: true, onCreateEmptyRow })
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.contextMenu(root)
    expect(screen.getByRole('menuitem', { name: /Insert empty row/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Insert empty row/ }))
    expect(onCreateEmptyRow).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('inserts immediately for an empty grid and ignores non-actionable context targets', () => {
    const onCreateEmptyRow = vi.fn()
    const { container } = renderGrid(
      {
        editable: true,
        onCreateEmptyRow,
        result: { ...result, rows: [], row_count: 0 },
      },
    )
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.contextMenu(root)
    expect(onCreateEmptyRow).toHaveBeenCalledOnce()

    const cell = document.createElement('div')
    cell.className = 'ag-cell'
    root.append(cell)
    fireEvent.contextMenu(cell)
    expect(onCreateEmptyRow).toHaveBeenCalledOnce()

    const readOnly = renderGrid({ result: { ...result, rows: [], row_count: 0 } })
    const readOnlyRoot = readOnly.container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.contextMenu(readOnlyRoot)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes an open menu on body scroll', async () => {
    renderGrid({ editable: true, onCreateEmptyRow: vi.fn() })
    const { container } = renderGrid({ editable: true, onCreateEmptyRow: vi.fn() })
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.contextMenu(root)
    expect(screen.getByRole('menu', { name: 'Grid actions' })).toBeInTheDocument()
    act(() => {
      gridProps().onBodyScroll?.()
    })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('handles a missing column field or row data and copies an empty cell value', async () => {
    renderGrid()
    const props = gridProps()
    act(() => {
      props.onCellContextMenu?.({
        event: { preventDefault: vi.fn(), clientX: 1, clientY: 2 },
        api: { getSelectedRows: () => [] },
        colDef: {},
        value: null,
        data: null,
      })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy cell/ }))
    expect(mockClipboardWrite).toHaveBeenCalledWith('')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

})

describe('ResultGrid draft focus and defensive branches', () => {
  it('focuses a newly inserted draft in its first editable column', () => {
    vi.useFakeTimers()
    try {
      renderGrid({
        columns: [column('id', { is_auto_increment: true }), column('name')],
        insertDrafts: new Map([['draft', { id: 3, name: 'Carol' }]]),
      })
      const api = {
        forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => {
          callback({ data: { __ag_rowId: 'draft' }, rowIndex: 0 })
        },
        ensureIndexVisible: vi.fn(),
        setFocusedCell: vi.fn(),
        startEditingCell: vi.fn(),
        getEditingCells: () => [],
      }
      installApi(api)
      act(() => {
        vi.runAllTimers()
      })
      expect(api.ensureIndexVisible).toHaveBeenCalledWith(0, 'middle')
      expect(api.setFocusedCell).toHaveBeenCalledWith(0, 'name')
      expect(api.startEditingCell).toHaveBeenCalledWith({ rowIndex: 0, colKey: 'name' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not focus a draft that is not in the displayed model or has no visible column', () => {
    vi.useFakeTimers()
    try {
      const missing = {
        forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => callback({ data: {}, rowIndex: 0 }),
        ensureIndexVisible: vi.fn(),
        setFocusedCell: vi.fn(),
        startEditingCell: vi.fn(),
      }
      renderGrid({ insertDrafts: new Map([['missing', {}]]) })
      installApi(missing)
      act(() => {
        vi.runAllTimers()
      })
      expect(missing.ensureIndexVisible).not.toHaveBeenCalled()

      const empty = {
        forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => {
          callback({ data: { __ag_rowId: 'empty' }, rowIndex: 0 })
        },
        ensureIndexVisible: vi.fn(),
        setFocusedCell: vi.fn(),
        startEditingCell: vi.fn(),
      }
      renderGrid({
        result: { ...result, columns: [], rows: [], row_count: 0 },
        insertDrafts: new Map([['empty', {}]]),
      })
      installApi(empty)
      act(() => {
        vi.runAllTimers()
      })
      expect(empty.ensureIndexVisible).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('finds no current match before the debounced scan completes and routes row ids', () => {
    renderGrid()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(gridProps().columnDefs[1].cellClassRules['find-match-current']({
      rowIndex: 0,
      column: { getColId: () => 'name' },
    })).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(gridProps().getRowId({ data: gridProps().rowData[0] })).toBe(gridProps().rowData[0].__ag_rowId)
  })

  it('returns empty filtered rows for null values and selected rows without an id', () => {
    const ref = createRef<ResultGridHandle>()
    renderGrid({ ref })
    const api = {
      forEachNodeAfterFilterAndSort: (callback: (node: any) => void) => {
        callback({ data: { id: 1 }, isSelected: () => false })
      },
      getSelectedNodes: () => [{ data: { id: 1 }, isSelected: () => true }],
    }
    installApi(api)
    expect(ref.current?.getFilteredData().rows).toEqual([[1, null, null]])
    expect(ref.current?.getSelectedData().rows).toEqual([[1, null, null]])
  })

  it('renders query failures in the dedicated error state', () => {
    renderGrid({ result: { ...result, error: '(1356, "View is broken")' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Query failed')
    expect(screen.queryByTestId('ag-grid')).not.toBeInTheDocument()
  })
})
