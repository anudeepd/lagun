import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tooltip from '../../components/ui/Tooltip'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Tooltip behavior details', () => {
  it('composes child handlers and caller descriptions', async () => {
    const onMouseEnter = vi.fn()
    const onMouseLeave = vi.fn()
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(
      <>
        <p id="own-description">Own description</p>
        <Tooltip label="Bottom tip" side="bottom">
          <button
            type="button"
            aria-label="Details"
            aria-describedby="own-description"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            onFocus={onFocus}
            onBlur={onBlur}
          >
            Details
          </button>
        </Tooltip>
      </>,
    )
    const button = screen.getByRole('button', { name: 'Details' })

    fireEvent.mouseEnter(button)
    expect(onMouseEnter).toHaveBeenCalledOnce()
    const tip = screen.getByRole('tooltip')
    expect(button.getAttribute('aria-describedby')).toContain('own-description')
    expect(button.getAttribute('aria-describedby')).toContain(tip.id)
    expect(tip.style.top).not.toBe('')

    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(button)
    expect(onMouseLeave).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

    fireEvent.focus(button)
    expect(onFocus).toHaveBeenCalledOnce()
    fireEvent.blur(button)
    expect(onBlur).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('does not throw when a layout measurement is unavailable', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(undefined as unknown as DOMRect)
    render(
      <Tooltip label="Measured">
        <button type="button">Measured</button>
      </Tooltip>,
    )

    fireEvent.focus(screen.getByRole('button', { name: 'Measured' }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Measured')
  })

  it('uses zero tooltip dimensions when only the trigger can be measured', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tooltip') return undefined as unknown as DOMRect
      return {
        width: 40,
        height: 20,
        top: 100,
        right: 140,
        bottom: 120,
        left: 100,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }
    })
    render(
      <Tooltip label="Unmeasured tip" side="bottom">
        <button type="button">Trigger</button>
      </Tooltip>,
    )

    fireEvent.focus(screen.getByRole('button', { name: 'Trigger' }))

    const tip = await screen.findByRole('tooltip')
    expect(tip.style.left).toBe('120px')
    expect(tip.style.top).toBe('126px')
  })
})
