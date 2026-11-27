import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ResultToolbar from '../../components/editor/ResultToolbar'
import type { QueryResult } from '../../types'

const result: QueryResult = {
  columns: ['id'],
  rows: [[1]],
  row_count: 1234,
  exec_time_ms: 9,
}

describe('ResultToolbar behavior', () => {
  it('shows nothing while idle', () => {
    const { container } = render(<ResultToolbar result={null} running={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('announces a running query before any result state', () => {
    render(<ResultToolbar result={{ ...result, error: 'boom' }} running />)
    expect(screen.getByText('Executing…')).toBeInTheDocument()
    expect(screen.queryByText('Error')).not.toBeInTheDocument()
  })

  it('shows an error result', () => {
    render(<ResultToolbar result={{ ...result, error: 'boom' }} running={false} />)
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('shows the full success metadata when optional values are present', () => {
    render(
      <ResultToolbar
        result={{ ...result, affected_rows: 8, insert_id: 42 }}
        running={false}
      />,
    )
    expect(screen.getByText('1,234 rows')).toBeInTheDocument()
    expect(screen.getByText('8 affected')).toBeInTheDocument()
    expect(screen.getByText('9ms')).toBeInTheDocument()
    expect(screen.getByText('insert_id=42')).toBeInTheDocument()
  })

  it('keeps zero affected rows and omits a falsy insert id', () => {
    render(
      <ResultToolbar
        result={{ ...result, affected_rows: 0, insert_id: 0 }}
        running={false}
      />,
    )
    expect(screen.getByText('0 affected')).toBeInTheDocument()
    expect(screen.queryByText(/insert_id=/)).not.toBeInTheDocument()
  })
})
