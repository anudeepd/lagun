import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Select from '../../components/ui/Select'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function options() {
  return [
    <option key="csv" value="csv">CSV</option>,
    <option key="json" value="json" disabled>JSON</option>,
    <option key="xml" value="xml">XML</option>,
  ]
}

function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  return screen.getByRole('listbox')
}

describe('Select option parsing and value ownership', () => {
  it('ignores non-option children and updates uncontrolled selection', () => {
    const onChange = vi.fn()
    render(
      <Select label="Format" defaultValue="csv" onChange={onChange}>
        {options()}
        <span>Not an option</span>
        {'stray text'}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    expect(trigger).toHaveTextContent('CSV')

    openSelect(trigger)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.click(screen.getByRole('option', { name: 'XML' }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0].target.value).toBe('xml')
    expect(trigger).toHaveTextContent('XML')
    expect(trigger).toHaveFocus()
  })

  it('lets a controlled value own the trigger label', () => {
    const onChange = vi.fn()
    render(
      <Select label="Format" value="csv" onChange={onChange}>
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'XML' }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(trigger).toHaveTextContent('CSV')
  })

  it('derives values from labels and supports numeric and disabled options', () => {
    render(
      <Select aria-label="Priority" defaultValue="1">
        <option>1</option>
        <option value={2}>Two</option>
        <option value="3" disabled>Three</option>
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Priority' })
    expect(trigger).toHaveTextContent('1')

    openSelect(trigger)
    const visible = screen.getAllByRole('option')
    expect(visible.map(option => option.textContent)).toEqual(['1', 'Two'])
    expect(visible[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the first option for a controlled value that is not present', () => {
    render(
      <Select label="Format" value="missing">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })

    expect(trigger).toHaveTextContent('CSV')
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'CSV' })).toHaveFocus()
  })

  it('leaves an empty select closed from clicks and keys', () => {
    render(
      <Select label="Empty">
        <option value="only" disabled>Disabled</option>
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Empty' })

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('leaves a disabled select closed from clicks and keys', () => {
    render(
      <Select label="Format" disabled>
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: ' ' })

    expect(trigger).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('Select trigger keyboard behavior', () => {
  it.each(['ArrowDown', 'Enter', ' '])('opens on %s at the selected option', key => {
    cleanup()
    render(
      <Select label="Format" defaultValue="xml">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    fireEvent.keyDown(trigger, { key })

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: 'XML' })).toHaveFocus()
  })

  it('starts a missing selection at the first enabled option', () => {
    render(
      <Select label="Format" defaultValue="missing">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    fireEvent.keyDown(trigger, { key: 'Enter' })

    expect(screen.getByRole('option', { name: 'CSV' })).toHaveFocus()
  })

  it('opens from ArrowUp on the last enabled option', () => {
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    expect(screen.getByRole('option', { name: 'XML' })).toHaveFocus()
  })
})

describe('Select listbox keyboard behavior', () => {
  it('moves focus with arrows, Home, and End and activates with Enter or Space', () => {
    const onChange = vi.fn()
    render(
      <Select label="Format" defaultValue="csv" onChange={onChange}>
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    openSelect(trigger)

    let current = screen.getByRole('option', { name: 'CSV' })
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    current = screen.getByRole('option', { name: 'XML' })
    expect(current).toHaveFocus()
    fireEvent.keyDown(current, { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: 'CSV' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'CSV' }), { key: 'End' })
    expect(screen.getByRole('option', { name: 'XML' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'XML' }), { key: 'Home' })
    expect(screen.getByRole('option', { name: 'CSV' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('option', { name: 'CSV' }), { key: 'x' })
    expect(screen.getByRole('option', { name: 'CSV' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('option', { name: 'CSV' }), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { value: 'csv' } }),
    )

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('option', { name: 'XML' }), { key: ' ' })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { value: 'xml' } }),
    )
  })

  it('closes on Tab outside a dialog and returns focus to the trigger', () => {
    render(
      <Select label="Format" defaultValue="xml">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    openSelect(trigger)
    const option = screen.getByRole('option', { name: 'XML' })
    option.focus()

    fireEvent.keyDown(option, { key: 'Tab' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('stays open on Tab inside a dialog and moves focus to the trigger', () => {
    render(
      <div role="dialog" aria-label="Details">
        <Select label="Format" defaultValue="xml">
          {options()}
        </Select>
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    openSelect(trigger)
    const option = screen.getByRole('option', { name: 'XML' })
    option.focus()

    fireEvent.keyDown(option, { key: 'Tab' })

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('Select dismissal and positioning', () => {
  it('closes on Escape but not on other keys', () => {
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    openSelect(trigger)

    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps the list open for pointer events in its root or portal and closes outside', () => {
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Format' })
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')

    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(listbox)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('supports compact width and gap rules', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 50,
      height: 16,
      top: 100,
      bottom: 116,
      left: 20,
      right: 70,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    })
    render(
      <Select label="Engine" defaultValue="csv" compact>
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Engine' })
    expect(trigger).toHaveClass('text-xs')
    fireEvent.click(trigger)

    const listbox = screen.getByRole('listbox')
    expect(Number.parseInt(listbox.style.width, 10)).toBe(96)
    expect(Number.parseInt(listbox.style.top, 10)).toBe(119)
  })

  it('positions above when below is too short and above is larger', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 20,
      top: 660,
      bottom: 760,
      left: 100,
      right: 220,
      x: 100,
      y: 660,
      toJSON: () => ({}),
    })
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveClass('origin-bottom')
    expect(listbox.style.bottom).not.toBe('')
    expect(listbox.style.top).toBe('')
  })

  it('positions below when both sides are too short but above is not larger', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 120,
      height: 20,
      top: 0,
      bottom: 760,
      left: 100,
      right: 220,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    })
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveClass('origin-top')
    expect(listbox.style.top).not.toBe('')
  })

  it('does not throw when measurement is unavailable', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(undefined as unknown as DOMRect)
    render(
      <Select label="Format" defaultValue="csv">
        {options()}
      </Select>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})

describe('Select accessibility presentation', () => {
  it('uses an explicit aria label and error description without a visible label', () => {
    render(
      <Select aria-label="Target" error="Choose a target" defaultValue="csv">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Target' })
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a target')
    expect(trigger).toHaveAttribute('aria-describedby', screen.getByRole('alert').id)

    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toHaveAccessibleName('Target')
  })

  it('uses the visible label for both trigger and listbox', () => {
    render(
      <Select label="Encoding" defaultValue="csv">
        {options()}
      </Select>,
    )
    const trigger = screen.getByRole('button', { name: 'Encoding' })
    fireEvent.click(trigger)

    expect(screen.getByRole('listbox')).toHaveAccessibleName('Encoding')
    expect(screen.getByRole('option', { name: 'CSV' })).toHaveClass('bg-brand-600')
    expect(screen.getByRole('option', { name: 'XML' }).lastElementChild)
      .toHaveClass('opacity-0')
  })
})
