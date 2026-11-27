import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QueryErrorState from '../../components/editor/QueryErrorState'
import { clipboardWrite } from '../../utils/clipboard'

vi.mock('../../utils/clipboard', () => ({ clipboardWrite: vi.fn() }))
const mockClipboardWrite = vi.mocked(clipboardWrite)

describe('QueryErrorState copy and guidance behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockClipboardWrite.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a plain error without a code and confirms then resets copy state', async () => {
    mockClipboardWrite.mockResolvedValue(undefined)
    render(<QueryErrorState error="Connection lost" />)
    expect(screen.queryByText(/Database error/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Check the view definition/)).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy query error' }))
    })
    expect(mockClipboardWrite).toHaveBeenCalledWith('Connection lost')
    expect(screen.getByRole('button', { name: 'Copy query error' })).toHaveTextContent('Copied')

    act(() => {
      vi.advanceTimersByTime(1800)
    })
    expect(screen.getByRole('button', { name: 'Copy query error' })).toHaveTextContent('Copy')
  })

  it('stays copyable when clipboard access fails', async () => {
    mockClipboardWrite.mockRejectedValueOnce(new Error('denied'))
    render(<QueryErrorState error={'(1356, "View \'demo\' is broken")'} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy query error' }))
    })
    expect(mockClipboardWrite).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Copy query error' })).toHaveTextContent('Copy')
    expect(screen.getByText(/Check the view definition and grants/)).toBeInTheDocument()
  })
})
