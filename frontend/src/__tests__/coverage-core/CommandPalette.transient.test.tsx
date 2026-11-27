import { useLayoutEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from '../../components/ui/CommandPalette'
import { useSessionStore } from '../../store/sessionStore'
import { useTabStore } from '../../store/tabStore'

afterEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useTabStore.setState({ tabs: [], activeTabId: null, pendingSqls: {} })
})

describe('CommandPalette stale selection timing', () => {
  it('ignores Enter when a filtered list has not yet reset an out-of-range active row', async () => {
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useTabStore.setState({
      tabs: [
        { id: 'one', type: 'query', label: 'One', sessionId: 's' },
        { id: 'two', type: 'query', label: 'Two', sessionId: 's' },
        { id: 'three', type: 'query', label: 'Three', sessionId: 's' },
        { id: 'four', type: 'query', label: 'Four', sessionId: 's' },
      ],
      activeTabId: 'one',
    })
    const onClose = vi.fn()

    function BurstHarness() {
      const [tick, setTick] = useState(0)

      useLayoutEffect(() => {
        if (tick === 0) return
        const input = document.querySelector<HTMLInputElement>('[role="combobox"]')
        input?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }))
      }, [tick])

      return (
        <>
          <button
            type="button"
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('[role="combobox"]')
              if (input) {
                const setValue = Object.getOwnPropertyDescriptor(
                  HTMLInputElement.prototype,
                  'value',
                )?.set
                setValue?.call(input, 'Switch to Three')
                input.dispatchEvent(new Event('input', { bubbles: true }))
              }
              setTick(1)
            }}
          >
            Filter and enter
          </button>
          <CommandPalette open onClose={onClose} />
        </>
      )
    }

    render(<BurstHarness />)
    const input = screen.getByRole('combobox')
    input.focus()
    fireEvent.keyDown(input, { key: 'End' })
    expect(screen.getAllByRole('option')).toHaveLength(4)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter and enter' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(onClose).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe('one')
  })
})
