import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GridSearchBar from '../../components/editor/GridSearchBar'

const motionState = vi.hoisted(() => ({ reduce: false }))
vi.mock('motion/react', async importOriginal => ({
  ...await importOriginal<typeof import('motion/react')>(),
  useReducedMotion: () => motionState.reduce,
}))

function renderBar(props: Partial<React.ComponentProps<typeof GridSearchBar>> = {}) {
  return render(
    <GridSearchBar
      open
      query=""
      matchCount={0}
      currentMatch={0}
      onQueryChange={vi.fn()}
      onNext={vi.fn()}
      onPrev={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )
}

describe('GridSearchBar coverage behavior', () => {
  beforeEach(() => {
    motionState.reduce = false
  })

  it('explains the empty query and disables navigation without matches', () => {
    renderBar({ query: 'missing', matchCount: 0 })
    expect(screen.getByRole('status')).toHaveTextContent('No matches')
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
  })

  it('shows match position and enables both navigation buttons', () => {
    renderBar({ query: 'a', matchCount: 12, currentMatch: 3 })
    expect(screen.getByRole('status')).toHaveTextContent('3 of 12')
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeEnabled()
  })

  it('renders both reduced-motion animation branches', () => {
    const { rerender } = renderBar({ query: 'a', matchCount: 1, currentMatch: 1 })
    motionState.reduce = true
    rerender(
      <GridSearchBar
        open
        query="a"
        matchCount={1}
        currentMatch={1}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })

  it('forwards every search and close action', () => {
    const onQueryChange = vi.fn()
    const onNext = vi.fn()
    const onPrev = vi.fn()
    const onClose = vi.fn()
    renderBar({ query: 'a', matchCount: 2, currentMatch: 1, onQueryChange, onNext, onPrev, onClose })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ab' } })
    expect(onQueryChange).toHaveBeenCalledWith('ab')
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onNext).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter', shiftKey: true })
    expect(onPrev).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
