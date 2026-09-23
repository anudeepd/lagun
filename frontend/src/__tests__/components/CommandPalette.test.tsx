import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CommandPalette from '../../components/ui/CommandPalette'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'
import type { Session } from '../../types'

const session: Session = {
  id: 'session-1',
  name: 'local',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  default_db: 'lagun_demo',
  query_limit: 1000,
  ssl_enabled: false,
  selected_databases: [],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
}

// Mirrors how AppLayout drives the palette: a separate opener, unrelated to the
// component's own keyboard handling.
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      <CommandPalette open={open} onClose={() => { setOpen(false); onClose() }} />
    </>
  )
}

function seedStores() {
  useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' })
  useTabStore.setState({
    tabs: [
      { id: 'tab-1', type: 'query', label: 'Query 1', sessionId: 'session-1' },
      { id: 'tab-2', type: 'query', label: 'Query 2', sessionId: 'session-1' },
    ],
    activeTabId: 'tab-1',
  })
}

// One session + two tabs → three commands: new query tab, then one per tab.
async function openPalette(onClose = () => {}) {
  seedStores()
  const user = userEvent.setup()
  render(<Harness onClose={onClose} />)
  await user.click(screen.getByRole('button', { name: 'Open palette' }))
  const input = screen.getByRole('combobox')
  // Modal restores focus on a rAF; the input is autofocused, but pin it so the
  // key events below cannot land on `body`.
  input.focus()
  return { user, input }
}

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup()
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens as a combobox wired to the listbox and its first option', async () => {
    const { input } = await openPalette()

    expect(screen.getByRole('dialog', { name: 'Command Palette' })).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('autocomplete', 'off')

    const listbox = screen.getByRole('listbox')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    expect(listbox).toHaveAttribute('aria-label', 'Commands')

    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('moves the active option with ArrowDown/ArrowUp and wraps at both ends', async () => {
    const { user, input } = await openPalette()
    const options = screen.getAllByRole('option')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id)

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id)
  })

  it('moves the active option with Home and End', async () => {
    const { user, input } = await openPalette()
    const options = screen.getAllByRole('option')

    await user.keyboard('{End}')
    expect(input).toHaveAttribute('aria-activedescendant', options[2].id)

    await user.keyboard('{Home}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('runs the active command on Enter and closes the palette', async () => {
    const onClose = vi.fn()
    const { user, input } = await openPalette(onClose)

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Switch to Query 2/ }).id)

    await user.keyboard('{Enter}')

    expect(useTabStore.getState().activeTabId).toBe('tab-2')
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('still runs a command on click', async () => {
    const { user } = await openPalette()

    await user.click(screen.getByRole('option', { name: /Switch to Query 2/ }))

    expect(useTabStore.getState().activeTabId).toBe('tab-2')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    const { user } = await openPalette(onClose)

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('filters as you type and resets the active option to the first match', async () => {
    const { user, input } = await openPalette()

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2].id)

    await user.type(input, 'switch')

    const matched = screen.getAllByRole('option')
    expect(matched).toHaveLength(2)
    expect(matched[0]).toHaveTextContent('Switch to Query 1')
    expect(input).toHaveAttribute('aria-activedescendant', matched[0].id)

    await user.clear(input)
    await user.type(input, 'new')

    const narrowed = screen.getAllByRole('option')
    expect(narrowed).toHaveLength(1)
    expect(narrowed[0]).toHaveTextContent('New query tab')
    expect(input).toHaveAttribute('aria-activedescendant', narrowed[0].id)
  })

  it('reports no options and an open combobox when nothing matches', async () => {
    const { user, input } = await openPalette()

    await user.type(input, 'zzzz')

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })

  it('points the active option at the row the pointer is over', async () => {
    const { input } = await openPalette()
    const option = screen.getAllByRole('option')[2]

    fireEvent.mouseMove(option)

    expect(input).toHaveAttribute('aria-activedescendant', option.id)
  })

  it('scrolls the active option into view', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, writable: true, configurable: true })
    try {
      const { user } = await openPalette()
      const options = screen.getAllByRole('option')

      await user.keyboard('{ArrowDown}')

      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances[scrollIntoView.mock.instances.length - 1]).toBe(options[1])
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})
