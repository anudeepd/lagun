import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LimitSelect from '../../components/ui/LimitSelect'
import { useServerConfigStore } from '../../store/serverConfigStore'

const OPTIONS = [100, 500, 1000, 10000] as const

beforeEach(() => {
  useServerConfigStore.setState({ queryMaxResultRows: 1_000_000 })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    queueMicrotask(() => callback(0))
    return 1
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function openWithKeyboard(key: string, value?: number) {
  cleanup()
  const onChange = vi.fn()
  render(<LimitSelect value={value} options={OPTIONS} onChange={onChange} />)
  const trigger = screen.getByRole('button', { name: 'Row limit' })
  fireEvent.keyDown(trigger, { key })
  return { onChange, trigger }
}

describe('LimitSelect preset selection', () => {
  it('selects a preset, reports it, closes, and returns focus to the trigger', () => {
    const onChange = vi.fn()
    render(<LimitSelect value={100} options={OPTIONS} onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Row limit' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: '500' }))

    expect(onChange).toHaveBeenCalledWith(500)
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens with ArrowDown and ArrowUp on the selected or edge item', () => {
    const down = openWithKeyboard('ArrowDown', 500)
    expect(down.trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: '500' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })

    const up = openWithKeyboard('ArrowUp', 500)
    expect(up.trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: '10,000' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
  })

  it('opens from Enter and Space, with a non-preset value starting at the first option', () => {
    openWithKeyboard('Enter', 777)
    expect(screen.getByRole('option', { name: '100' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })

    const space = openWithKeyboard(' ', 777)
    expect(space.trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: '100' })).toHaveFocus()
  })

  it('starts a triggered click at the first option when the value is not in the list', () => {
    render(<LimitSelect value={777} options={OPTIONS} onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))

    expect(screen.getByRole('option', { name: '100' })).toHaveFocus()
  })
})

describe('LimitSelect keyboard navigation inside the listbox', () => {
  it('moves with arrows, Home, End, and activates options with Enter or Space', () => {
    const onChange = vi.fn()
    render(<LimitSelect value={100} options={OPTIONS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))

    const first = screen.getByRole('option', { name: '100' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: '500' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: '500' }), { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: '100' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: '100' }), { key: 'End' })
    expect(screen.getByRole('option', { name: 'Custom…' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'Custom…' }), { key: 'Home' })
    expect(screen.getByRole('option', { name: '100' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('option', { name: '500' }), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(500)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.keyDown(screen.getByRole('option', { name: '1,000' }), { key: ' ' })
    expect(onChange).toHaveBeenLastCalledWith(1000)
  })

  it('enters custom mode from custom option keyboard activation', () => {
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} ariaLabel="Result cap" />)
    const trigger = screen.getByRole('button', { name: 'Result cap' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('option', { name: 'Custom…' }), { key: ' ' })

    expect(screen.getByRole('spinbutton', { name: 'Custom result cap' })).toHaveFocus()
  })
})

describe('LimitSelect custom value editing', () => {
  function openCustom(value?: number) {
    cleanup()
    const onChange = vi.fn()
    render(<LimitSelect value={value} options={OPTIONS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.click(screen.getByRole('option', { name: 'Custom…' }))
    const input = screen.getByRole('spinbutton', { name: 'Custom row limit' })
    return { input, onChange }
  }

  it('prefills an absent value with an empty draft', () => {
    const { input } = openCustom(undefined)
    expect(input).toHaveValue(null)
  })

  it.each([
    ['', '1 and 1,000,000'],
    ['abc', '1 and 1,000,000'],
    ['1.5', '1 and 1,000,000'],
    ['0', '1 and 1,000,000'],
    ['1000001', '1 and 1,000,000'],
    ['9007199254740993', '1 and 1,000,000'],
  ])('rejects invalid draft %j without changing the limit', (draft, message) => {
    const { input, onChange } = openCustom(100)
    fireEvent.change(input, { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply row limit' }))

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(input).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears a validation error as soon as the draft changes and applies a valid value', async () => {
    const { input, onChange } = openCustom(500)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply row limit' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '250000' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.submit(input.closest('form')!)

    expect(onChange).toHaveBeenCalledWith(250000)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Row limit' })).toHaveFocus()
    )
  })

  it('cancels with the button and with Escape', async () => {
    const button = openCustom(500)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel custom row limit' }))
    expect(button.onChange).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Row limit' })).toHaveFocus()
    )

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.click(screen.getByRole('option', { name: 'Custom…' }))
    const input = screen.getByRole('spinbutton', { name: 'Custom row limit' })
    fireEvent.keyDown(input, { key: 'a' })
    expect(screen.getByRole('spinbutton')).toBe(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })

  it('falls back to the built-in ceiling when the configured ceiling is zero', () => {
    useServerConfigStore.setState({ queryMaxResultRows: 0 })
    openCustom(100)

    expect(screen.getByRole('spinbutton', { name: 'Custom row limit' }))
      .toHaveAttribute('max', '1000000')
  })
})

describe('LimitSelect dismissal and positioning', () => {
  it('ignores unrelated trigger and option keys', () => {
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Row limit' })

    fireEvent.keyDown(trigger, { key: 'x' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    const option = screen.getByRole('option', { name: '100' })
    fireEvent.keyDown(option, { key: 'x' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(option).toHaveFocus()
  })

  it('keeps the menu open for clicks inside it and closes for outside pointers', () => {
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Row limit' })
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')

    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(listbox)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Escape and ignores other document keys', () => {
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'Row limit' })
    fireEvent.click(trigger)

    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('does not throw when layout measurement is unavailable', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(undefined as unknown as DOMRect)
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))

    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('positions the list above when there is more room there', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 20,
      top: 660,
      right: 220,
      bottom: 760,
      left: 100,
      x: 100,
      y: 660,
      toJSON: () => ({}),
    })
    render(<LimitSelect value={100} options={OPTIONS} onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))

    expect(screen.getByRole('listbox')).toHaveStyle({ position: 'fixed' })
    expect(Number.parseInt(screen.getByRole('listbox').style.top, 10)).toBeLessThan(660)
  })
})
