import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GridSearchBar from '../../components/editor/GridSearchBar'

function renderBar(props: Partial<React.ComponentProps<typeof GridSearchBar>> = {}) {
  const defaultProps = {
    open: true,
    query: '',
    matchCount: 0,
    currentMatch: 0,
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
  }
  return render(<GridSearchBar {...defaultProps} {...props} />)
}

describe('GridSearchBar', () => {
  it('renders nothing when closed', () => {
    renderBar({ open: false })
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('renders the search input and focuses it when open', () => {
    renderBar()
    const input = screen.getByRole('searchbox')
    expect(input).toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it('exposes searchbox role and a polite live region for the count', () => {
    renderBar({ matchCount: 3, currentMatch: 1 })
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    expect(screen.getByText('1 of 3')).toHaveAttribute('aria-live', 'polite')
  })

  it('calls onQueryChange as the user types', async () => {
    const onQueryChange = vi.fn()
    renderBar({ onQueryChange })
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'abc')
    expect(onQueryChange).toHaveBeenCalledWith('a')
    expect(onQueryChange).toHaveBeenCalledWith('b')
    expect(onQueryChange).toHaveBeenCalledWith('c')
  })

  it('Enter calls onNext, Shift+Enter calls onPrev, Esc calls onClose', async () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    const onClose = vi.fn()
    renderBar({ onNext, onPrev, onClose })
    const input = screen.getByRole('searchbox')

    await userEvent.type(input, '{Enter}')
    expect(onNext).toHaveBeenCalledOnce()

    await userEvent.type(input, '{Shift>}{Enter}{/Shift}')
    expect(onPrev).toHaveBeenCalledOnce()

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows the current-of-total match count', () => {
    renderBar({ matchCount: 5, currentMatch: 2 })
    expect(screen.getByText('2 of 5')).toBeInTheDocument()
  })

  it('shows "No matches" in the warning color when there are zero matches', () => {
    renderBar({ matchCount: 0, currentMatch: 0 })
    const el = screen.getByText('No matches')
    expect(el).toBeInTheDocument()
    expect(el).toHaveClass('text-amber-400')
  })

  it('X button calls onClose', async () => {
    const onClose = vi.fn()
    renderBar({ onClose })
    await userEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('prev/next buttons call onPrev/onNext', async () => {
    const onPrev = vi.fn()
    const onNext = vi.fn()
    renderBar({ onPrev, onNext })
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(onPrev).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(onNext).toHaveBeenCalledOnce()
  })
})