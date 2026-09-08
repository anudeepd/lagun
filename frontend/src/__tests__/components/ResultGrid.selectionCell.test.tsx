import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import ResultGrid from '../../components/editor/ResultGrid'
import * as agGridReact from 'ag-grid-react'
import type { QueryResult } from '../../types'

// ag-grid does not fully run under jsdom, so we use the manual mock in
// frontend/__mocks__/ag-grid-react.ts and drive the onCellClicked prop
// directly with fake events built from real DOM nodes (so closest() and
// querySelector() behave like in the browser).
interface AgGridTestHooks {
  __calls: Record<string, unknown[]>
  __latestProps: { current: { onCellClicked?: (e: unknown) => void; selectionColumnDef?: { suppressNavigable?: boolean } } | null }
}
const { __calls, __latestProps } = agGridReact as unknown as AgGridTestHooks

vi.mock('ag-grid-react')
vi.mock('ag-grid-community', () => ({ themeQuartz: { withParams: () => ({}) } }))

const baseResult: QueryResult = {
  columns: ['name', 'age'],
  rows: [
    ['Alice', 30],
    ['Bob', 25],
  ],
  row_count: 2,
  exec_time_ms: 1,
}

type CellClickedEvent = {
  event: { target: HTMLElement }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: { isSelected: () => boolean; setSelected: (selected: boolean) => void } & Record<string, any>
  colDef: Record<string, unknown>
  rowIndex: number | null
  data: Record<string, unknown> | undefined
  value?: unknown
}

function renderSelectable() {
  render(<ResultGrid result={baseResult} selectable />)
  const handler = __latestProps.current?.onCellClicked
  if (!handler) throw new Error('onCellClicked is not wired to the grid')
  return handler as unknown as (e: CellClickedEvent) => void
}

function checkboxCell() {
  const cell = document.createElement('div')
  cell.className = 'ag-cell'
  const input = document.createElement('input')
  input.type = 'checkbox'
  cell.appendChild(input)
  return { cell, input }
}

function selectedNode(selected: boolean) {
  return { isSelected: () => selected, setSelected: vi.fn() }
}

function baseEvent(overrides: Partial<CellClickedEvent>): CellClickedEvent {
  return {
    event: { target: document.createElement('div') },
    node: selectedNode(false),
    colDef: {},
    rowIndex: 0,
    data: {},
    ...overrides,
  }
}

describe('ResultGrid selection checkbox cell', () => {
  beforeEach(() => {
    Object.keys(__calls).forEach(k => delete __calls[k])
    __latestProps.current = null
  })

  it('toggles the row on when the checkbox cell padding is clicked', () => {
    const onCellClicked = renderSelectable()
    const { cell } = checkboxCell()
    const node = selectedNode(false)
    onCellClicked(baseEvent({ event: { target: cell }, node }))
    expect(node.setSelected).toHaveBeenCalledWith(true)
  })

  it('toggles the row off when it is already selected', () => {
    const onCellClicked = renderSelectable()
    const { cell } = checkboxCell()
    const node = selectedNode(true)
    onCellClicked(baseEvent({ event: { target: cell }, node }))
    expect(node.setSelected).toHaveBeenCalledWith(false)
  })

  it('does not double-toggle when the checkbox itself is clicked', () => {
    const onCellClicked = renderSelectable()
    const { input } = checkboxCell()
    const node = selectedNode(false)
    onCellClicked(baseEvent({ event: { target: input }, node }))
    expect(node.setSelected).not.toHaveBeenCalled()
  })

  it('leaves normal data cells alone', () => {
    const onCellClicked = renderSelectable()
    const cell = document.createElement('div')
    cell.className = 'ag-cell'
    const node = selectedNode(false)
    onCellClicked(baseEvent({
      event: { target: cell },
      node,
      colDef: { field: 'name' },
      data: { name: 'Alice' },
      value: 'Alice',
    }))
    expect(node.setSelected).not.toHaveBeenCalled()
  })

  it('keeps the checkbox column out of keyboard navigation', () => {
    renderSelectable()
    expect(__latestProps.current?.selectionColumnDef).toEqual({ suppressNavigable: true })
  })
})
