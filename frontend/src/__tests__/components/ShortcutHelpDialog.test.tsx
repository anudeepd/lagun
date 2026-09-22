import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShortcutHelpDialog from '../../components/ui/ShortcutHelpDialog'
import { SHORTCUTS, type ShortcutGroup } from '../../utils/shortcuts'

// Groups render in the order they first appear in the registry.
const registryGroups = SHORTCUTS.reduce<ShortcutGroup[]>((groups, shortcut) => {
  if (!groups.includes(shortcut.group)) groups.push(shortcut.group)
  return groups
}, [])

function renderSheet(onClose = () => {}) {
  render(<ShortcutHelpDialog open onClose={onClose} />)
  return screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
}

describe('ShortcutHelpDialog', () => {
  it('renders every registry entry, in order, with its keys', () => {
    const dialog = renderSheet()

    const rows = Array.from(dialog.querySelectorAll<HTMLElement>('dl > div'))
    expect(rows).toHaveLength(SHORTCUTS.length)

    SHORTCUTS.forEach((shortcut, index) => {
      const row = rows[index]
      expect(within(row).getByText(shortcut.label)).toBeInTheDocument()
      expect(Array.from(row.querySelectorAll('kbd')).map(chip => chip.textContent)).toEqual(shortcut.keys)
    })
  })

  it('renders one section per group, in registry order', () => {
    const dialog = renderSheet()

    const headings = Array.from(dialog.querySelectorAll('h3')).map(heading => heading.textContent)
    expect(headings).toEqual(registryGroups)

    registryGroups.forEach(group => {
      const section = screen.getByRole('heading', { level: 3, name: group }).closest('section')
      const labels = Array.from(section?.querySelectorAll('dt') ?? []).map(dt => dt.textContent)
      expect(labels).toEqual(SHORTCUTS.filter(shortcut => shortcut.group === group).map(shortcut => shortcut.label))
    })
  })

  it('lists the shortcuts the sheet used to omit', () => {
    renderSheet()

    expect(screen.getByText('Find in results')).toBeInTheDocument()
    expect(screen.getByText('Copy focused cell value')).toBeInTheDocument()
    expect(screen.getByText('First or last tab when the tab bar is focused')).toBeInTheDocument()
  })

  it('closes from Done', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderSheet(onClose)

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(onClose).toHaveBeenCalled()
  })
})
