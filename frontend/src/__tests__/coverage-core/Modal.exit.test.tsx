import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Modal from '../../components/ui/Modal'

vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useIsPresent: () => false }
})

describe('Modal during exit', () => {
  it('removes active semantics and traps Tab on an otherwise empty focus set', () => {
    const onClose = vi.fn()
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    render(
      <Modal open onClose={onClose} title="Leaving" motionPreset="subtle">
        <span>Content</span>
      </Modal>,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const heading = screen.getByText('Leaving')
    const dialog = heading.parentElement!.parentElement as HTMLElement
    expect(dialog).not.toHaveAttribute('role')
    expect(dialog.parentElement).toHaveAttribute('aria-hidden', 'true')
    const close = document.querySelector(
      'button[aria-label="Close dialog"]',
    ) as HTMLButtonElement
    expect(close).toBeDisabled()

    const overlay = document.getElementById('lagun-overlays')!
    const backdrop = overlay.querySelector('.absolute.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false)

    root.remove()
  })
})
