import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Modal from '../../components/ui/Modal'

function ensureRoot(inert = false) {
  const root = document.createElement('div')
  root.id = 'root'
  root.inert = inert
  document.body.appendChild(root)
  return root
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
  vi.restoreAllMocks()
})

describe('Modal structure and focus target', () => {
  it('renders an alert dialog with footer and initial focus ref', () => {
    const onClose = vi.fn()
    ensureRoot()

    function Example() {
      const localRef = useRef<HTMLInputElement>(null)
      return (
        <Modal
          open
          onClose={onClose}
          title="Delete connection"
          alert
          descriptionId="delete-description"
          width="max-w-sm"
          footer={<button type="button">Cancel</button>}
          initialFocusRef={localRef}
        >
          <p id="delete-description">This cannot be undone.</p>
          <input ref={localRef} aria-label="Connection name" />
        </Modal>
      )
    }

    render(<Example />)

    const dialog = screen.getByRole('alertdialog', { name: 'Delete connection' })
    expect(dialog).toHaveAttribute('aria-describedby', 'delete-description')
    expect(dialog.className).toContain('max-w-sm')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Connection name' })).toHaveFocus()
    expect(document.getElementById('root')?.inert).toBe(true)
  })

  it('falls back to the first focusable when an initial target cannot take focus', () => {
    ensureRoot()
    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    document.body.appendChild(outside)
    const outsideRef = { current: outside }

    render(
      <Modal
        open
        onClose={() => {}}
        title="Edit"
        initialFocusRef={outsideRef}
      >
        <button type="button">First action</button>
      </Modal>,
    )

    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus()
  })

  it('preserves focus already placed by an autoFocus child', () => {
    ensureRoot()
    render(
      <Modal open onClose={() => {}} title="Cell editor">
        <textarea aria-label="Cell value" autoFocus />
      </Modal>,
    )

    expect(screen.getByRole('textbox', { name: 'Cell value' })).toHaveFocus()
  })

  it('skips opener restoration when disabled and tolerates no active opener', () => {
    ensureRoot()
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.appendChild(opener)
    opener.focus()

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Details" restoreFocus={false}>
        <button type="button">Action</button>
      </Modal>,
    )
    rerender(
      <Modal open={false} onClose={() => {}} title="Details" restoreFocus={false}>
        <button type="button">Action</button>
      </Modal>,
    )
    expect(opener).not.toHaveFocus()

    const activeElement = Object.getOwnPropertyDescriptor(document, 'activeElement')
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => null,
    })
    try {
      rerender(
        <Modal open onClose={() => {}} title="Details">
          <button type="button">Action</button>
        </Modal>,
      )
      expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument()
    } finally {
      if (activeElement) Object.defineProperty(document, 'activeElement', activeElement)
      else delete (document as unknown as { activeElement?: unknown }).activeElement
    }
  })

  it('does not require a #root container', () => {
    document.getElementById('root')?.remove()

    render(
      <Modal open onClose={() => {}} title="No root">
        <button type="button">Action</button>
      </Modal>,
    )

    expect(screen.getByRole('dialog', { name: 'No root' })).toBeInTheDocument()
  })

  it('restores a previously inert root after closing', () => {
    const root = ensureRoot(true)
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose} title="Details">
        <button type="button">Action</button>
      </Modal>,
    )
    expect(root.inert).toBe(true)

    rerender(
      <Modal open={false} onClose={onClose} title="Details">
        <button type="button">Action</button>
      </Modal>,
    )

    expect(root.inert).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('routes backdrop and close-button clicks to onClose', () => {
    ensureRoot()
    const onClose = vi.fn()
    const { container } = render(
      <Modal open onClose={onClose} title="Details">
        <button type="button">Action</button>
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledOnce()
    const overlay = document.getElementById('lagun-overlays')!
    const backdrop = overlay.querySelector('.absolute.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(container).not.toContainElement(overlay.firstElementChild as HTMLElement)
  })

  it('supports subtle motion', () => {
    ensureRoot()
    render(
      <Modal open onClose={() => {}} title="Subtle" motionPreset="subtle">
        <button type="button">Action</button>
      </Modal>,
    )

    expect(screen.getByRole('dialog', { name: 'Subtle' })).toBeInTheDocument()
  })

  it('throws when the portal root is absent', () => {
    ensureRoot()
    document.getElementById('lagun-overlays')?.remove()

    expect(() => render(
      <Modal open onClose={() => {}} title="Missing portal">
        <span>Body</span>
      </Modal>,
    )).toThrow('Missing #lagun-overlays portal root')
  })
})

describe('Modal keyboard trap', () => {
  it('wraps forward from last to first and backward from first to last', async () => {
    ensureRoot()
    const user = userEvent.setup()
    render(
      <Modal open onClose={() => {}} title="Focus">
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>,
    )
    const close = screen.getByRole('button', { name: 'Close dialog' })
    const last = screen.getByRole('button', { name: 'Last action' })

    close.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(last).toHaveFocus()

    await user.keyboard('{Tab}')
    expect(close).toHaveFocus()
  })

  it('leaves Tab untouched for interior controls and ignores unrelated keys', () => {
    ensureRoot()
    render(
      <Modal open onClose={() => {}} title="Focus">
        <button type="button">First action</button>
      </Modal>,
    )
    const action = screen.getByRole('button', { name: 'First action' })
    action.focus()

    expect(fireEvent.keyDown(window, { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(action).toHaveFocus()
  })

  it('closes on Escape and restores the opener', async () => {
    ensureRoot()
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose} title="Escape">
        <button type="button">Action</button>
      </Modal>,
    )

    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false)
    expect(onClose).toHaveBeenCalledOnce()

    rerender(
      <Modal open={false} onClose={onClose} title="Escape">
        <button type="button">Action</button>
      </Modal>,
    )
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
