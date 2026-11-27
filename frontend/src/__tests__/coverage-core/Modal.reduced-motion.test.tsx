import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Modal from '../../components/ui/Modal'

vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useReducedMotion: () => true }
})

describe('Modal reduced-motion entrances', () => {
  it('renders subtle and default presets without positional motion', () => {
    document.body.appendChild(Object.assign(document.createElement('div'), { id: 'root' }))
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Subtle" motionPreset="subtle">
        <button type="button">Action</button>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Subtle' })).toBeInTheDocument()

    rerender(
      <Modal open onClose={() => {}} title="Default">
        <button type="button">Action</button>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Default' })).toBeInTheDocument()
  })
})
