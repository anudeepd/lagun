import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ResultGrid, { type ResultGridHandle } from '../../components/editor/ResultGrid'
import type { QueryResult } from '../../types'

const gridState = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
}))

vi.mock('ag-grid-react', async () => {
  const React = await import('react')
  return {
    AgGridReact: React.forwardRef(function MockGrid(props: Record<string, any>, _ref: unknown) {
      gridState.props = props
      return React.createElement('div', { 'data-testid': 'grid-before-ready' })
    }),
  }
})
vi.mock('ag-grid-community', async (importOriginal) => ({
  ...await importOriginal<typeof import('ag-grid-community')>(),
  themeQuartz: { withParams: () => ({}) },
}))

const result: QueryResult = {
  columns: ['id', 'name'],
  rows: [[1, 'Alice']],
  row_count: 1,
  exec_time_ms: 2,
}

describe('ResultGrid before AG Grid reports ready', () => {
  it('returns safe empty imperative results and skips draft focusing', () => {
    vi.useFakeTimers()
    try {
      const ref = createRef<ResultGridHandle>()
      render(
        <ResultGrid
          ref={ref}
          result={result}
          insertDrafts={new Map([['draft', { id: 2 }]])}
          columns={[{ name: 'id', data_type: 'int', column_type: 'int', is_nullable: false, column_default: null, is_primary_key: true, is_auto_increment: true, extra: '', comment: '' }]}
        />,
      )
      act(() => {
        vi.runAllTimers()
      })
      expect(ref.current?.isAnyFilterPresent()).toBe(false)
      expect(ref.current?.isAnySortPresent()).toBe(false)
      expect(ref.current?.getFilteredData()).toEqual({
        columns: ['id', 'name'],
        rows: [],
        autoIncrementColumns: ['id'],
      })
      expect(ref.current?.getSelectedData()).toEqual({
        columns: ['id', 'name'],
        rows: [],
        autoIncrementColumns: ['id'],
      })
      expect(() => {
        ref.current?.scrollToTop()
        ref.current?.stopEditing()
        ref.current?.deselectAll()
        ref.current?.clearSort()
      }).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles find navigation and keyboard shortcuts without a grid API', async () => {
    const { container } = render(<ResultGrid result={result} />)
    const props = gridState.props!
    const root = container.querySelector('.lagun-result-grid') as HTMLElement
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Alice' } })
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))

    act(() => {
      props.onCellClicked({
        event: { target: document.createElement('div') },
        node: { isSelected: () => false, setSelected: vi.fn() },
        colDef: { field: 'name' },
        rowIndex: 0,
        value: 'Alice',
        data: { id: 1, name: 'Alice', __ag_rowId: 'row' },
      })
    })
    root.focus()
    fireEvent.keyDown(window, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'View cell' })).toBeInTheDocument()
  })
})
