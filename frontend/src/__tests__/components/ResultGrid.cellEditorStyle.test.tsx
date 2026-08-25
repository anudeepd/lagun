import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ResultGrid from '../../components/editor/ResultGrid'
import * as agGridReact from 'ag-grid-react'
import type { QueryResult } from '../../types'

vi.mock('ag-grid-react')
vi.mock('ag-grid-community', () => ({ themeQuartz: { withParams: () => ({}) } }))

const { __latestProps } = agGridReact as unknown as {
  __latestProps: { current: { onCellDoubleClicked?: (event: unknown) => void } | null }
}

const result: QueryResult = {
  columns: ['name'],
  rows: [['short']],
  row_count: 1,
  exec_time_ms: 1,
}

describe('ResultGrid cell editor styling', () => {
  it('uses readable monospace text in the large cell editor', async () => {
    render(<ResultGrid result={result} editable onCellEdit={vi.fn()} />)
    const value = 'A'.repeat(81)

    await act(async () => {
      __latestProps.current?.onCellDoubleClicked?.({
        colDef: { field: 'name' },
        rowIndex: 0,
        data: { name: value },
        value,
        api: {},
      })
    })

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Edit cell' })).toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Edit name' })).toHaveClass('font-mono', 'text-sm')
  })
})
