import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import QueryErrorState from '../../components/editor/QueryErrorState'
import { parseQueryError } from '../../components/editor/queryError'
import { clipboardWrite } from '../../utils/clipboard'

vi.mock('../../utils/clipboard', () => ({ clipboardWrite: vi.fn() }))

const mockClipboardWrite = vi.mocked(clipboardWrite)

beforeEach(() => {
  mockClipboardWrite.mockReset()
  mockClipboardWrite.mockResolvedValue(undefined)
})

describe('parseQueryError', () => {
  it('extracts MySQL code and unquotes driver tuple errors', () => {
    expect(parseQueryError('(1356, "View \\"demo\\" has invalid dependencies")')).toEqual({
      code: '1356',
      message: 'View "demo" has invalid dependencies',
      raw: '(1356, "View \\"demo\\" has invalid dependencies")',
    })
  })

  it('keeps non-MySQL errors intact', () => {
    expect(parseQueryError('Query cancelled')).toEqual({
      code: null,
      message: 'Query cancelled',
      raw: 'Query cancelled',
    })
  })

  it('extracts code from driver prefix errors', () => {
    expect(parseQueryError('ERROR 1146 (42S02): Table does not exist')).toEqual({
      code: '1146',
      message: 'Table does not exist',
      raw: 'ERROR 1146 (42S02): Table does not exist',
    })
  })
})

describe('QueryErrorState', () => {
  it('renders an accessible error with code, recovery guidance, and raw details', () => {
    const error = `(1356, "View 'demo' references invalid objects")`
    render(<QueryErrorState error={error} />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Query failed' })).toBeInTheDocument()
    expect(screen.getByText('Database error 1356')).toBeInTheDocument()
    expect(screen.getByText("View 'demo' references invalid objects")).toBeInTheDocument()
    expect(screen.getByText(/Check the view definition and grants/)).toBeInTheDocument()
    expect(screen.getByText(error)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy query error' })).toBeInTheDocument()
  })

  it('copies the complete raw error and confirms success', async () => {
    const user = userEvent.setup()
    const error = `(1356, "View 'demo' references invalid objects")`
    render(<QueryErrorState error={error} />)

    await user.click(screen.getByRole('button', { name: 'Copy query error' }))

    expect(mockClipboardWrite).toHaveBeenCalledWith(error)
    expect(screen.getByRole('button', { name: 'Copy query error' })).toHaveTextContent('Copied')
  })
})
