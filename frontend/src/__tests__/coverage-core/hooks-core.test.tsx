import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useEverOpened from '../../hooks/useEverOpened'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'
import { useHandoff } from '../../motion/useHandoff'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('useEverOpened', () => {
  it('latches open so an exited dialog remains mounted', () => {
    const { result, rerender } = renderHook(({ open }) => useEverOpened(open), {
      initialProps: { open: false },
    })

    expect(result.current).toBe(false)
    rerender({ open: true })
    expect(result.current).toBe(true)
    rerender({ open: false })
    expect(result.current).toBe(true)
  })

  it('starts latched when the dialog is already open', () => {
    const { result } = renderHook(() => useEverOpened(true))

    expect(result.current).toBe(true)
  })
})

describe('useMenuKeyboard', () => {
  function setup(itemCount = 3) {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const items = Array.from({ length: itemCount }, (_, index) => {
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = `Item ${index + 1}`
      menu.appendChild(item)
      return item
    })
    const opener = document.createElement('button')
    opener.textContent = 'Open menu'
    document.body.append(opener, menu)
    opener.focus()

    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const onClose = vi.fn()
    const menuRef = { current: menu }
    const hook = renderHook(
      ({ active = true, close = onClose }) => useMenuKeyboard(menuRef, close, active),
      { initialProps: { active: true, close: onClose } },
    )

    return { ...hook, menu, items, opener, onClose, menuRef, frame, cancel }
  }

  function key(keyName: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
      key: keyName,
      bubbles: true,
      cancelable: true,
      ...options,
    })
    window.dispatchEvent(event)
    return event
  }

  it('focuses the first item and cycles arrows, Home, and End', () => {
    const { items } = setup()
    expect(items[0]).toHaveFocus()

    let event = key('ArrowDown')
    expect(event.defaultPrevented).toBe(true)
    expect(items[1]).toHaveFocus()
    key('ArrowDown')
    expect(items[2]).toHaveFocus()
    key('ArrowDown')
    expect(items[0]).toHaveFocus()
    key('ArrowUp')
    expect(items[2]).toHaveFocus()
    key('Home')
    expect(items[0]).toHaveFocus()
    key('End')
    expect(items[2]).toHaveFocus()

    items[1].blur()
    document.body.focus()
    const opener = document.querySelector('button')
    opener?.focus()
    event = key('ArrowDown')
    expect(event.defaultPrevented).toBe(true)
    expect(items[0]).toHaveFocus()
    key('ArrowUp')
    expect(items[2]).toHaveFocus()
  })

  it('ignores navigation initiated outside the menu but closes from anywhere on Escape', () => {
    const { onClose } = setup()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const arrow = key('ArrowDown')
    expect(arrow.defaultPrevented).toBe(false)
    expect(outside).toHaveFocus()

    const escape = key('Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Tab, parks focus on the opener, and does not restore focus after unmount', () => {
    const { items, opener, onClose, unmount } = setup()
    items[1].focus()

    key('Tab')

    expect(onClose).toHaveBeenCalledOnce()
    expect(opener).toHaveFocus()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    unmount()
    expect(outside).toHaveFocus()
  })

  it('does not try to park focus on a detached opener', () => {
    const { items, opener, onClose } = setup()
    items[2].focus()
    opener.remove()

    expect(() => key('Tab')).not.toThrow()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does nothing for navigation when the menu has no items', () => {
    const { opener } = setup(0)
    opener.focus()

    const event = key('ArrowDown')

    expect(event.defaultPrevented).toBe(false)
    expect(opener).toHaveFocus()
  })

  it('ignores a non-navigation key while focus is inside the menu', () => {
    const { items } = setup()
    const event = key('a')

    expect(event.defaultPrevented).toBe(false)
    expect(items[0]).toHaveFocus()
  })

  it('focuses the last item when ArrowUp starts from the opener', () => {
    const { items, opener } = setup()
    opener.focus()

    key('ArrowUp')

    expect(items[2]).toHaveFocus()
  })

  it('treats a missing active element as no opener', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    menu.appendChild(item)
    document.body.appendChild(menu)
    const activeElement = Object.getOwnPropertyDescriptor(document, 'activeElement')
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => null,
    })
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })

    try {
      const { unmount } = renderHook(() => useMenuKeyboard({ current: menu }, vi.fn()))
      unmount()
      expect(frame).toHaveBeenCalled()
    } finally {
      if (activeElement) Object.defineProperty(document, 'activeElement', activeElement)
      else delete (document as unknown as { activeElement?: unknown }).activeElement
    }
  })

  it('uses the latest close callback without moving focus again on rerender', () => {
    const { items, rerender, frame } = setup()
    const latestClose = vi.fn()
    rerender({ active: true, close: latestClose })

    expect(items[0]).toHaveFocus()
    expect(frame).toHaveBeenCalledTimes(1)
    items[1].focus()
    key('Escape')
    expect(latestClose).toHaveBeenCalledOnce()
  })

  it('restores a connected opener when the menu closes without Tab', () => {
    const { opener, unmount } = setup()
    document.body.focus()

    unmount()

    expect(opener).toHaveFocus()
  })

  it('does not install listeners when inactive or without a menu element', () => {
    const active = renderHook(() => useMenuKeyboard({ current: null }, vi.fn(), true))
    active.unmount()

    const onClose = vi.fn()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    const inactive = renderHook(() => useMenuKeyboard({ current: menu }, onClose, false))

    key('Escape')
    expect(onClose).not.toHaveBeenCalled()
    inactive.unmount()
  })
})

describe('useHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  function setup(initial: { value: string | null; loading: boolean; minVisibleMs?: number }) {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const hook = renderHook(
      ({ value, loading, minVisibleMs = 100 }) =>
        useHandoff(value, loading, minVisibleMs),
      { initialProps: initial },
    )
    return {
      ...hook,
      setNow(value: number) { now = value },
    }
  }

  it('activates when the destination changes while loading', () => {
    const { result, rerender } = setup({ value: 'schema', loading: true })
    expect(result.current).toBe(false)

    rerender({ value: 'data', loading: true })

    expect(result.current).toBe(true)
  })

  it('activates when loading begins and stays visible for the minimum duration', () => {
    const { result, rerender, setNow } = setup({
      value: 'data',
      loading: false,
      minVisibleMs: 100,
    })
    expect(result.current).toBe(false)

    rerender({ value: 'data', loading: true, minVisibleMs: 100 })
    expect(result.current).toBe(true)

    setNow(1_050)
    rerender({ value: 'data', loading: false, minVisibleMs: 100 })
    act(() => vi.advanceTimersByTime(49))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(false)
  })

  it('hides immediately after the minimum has already elapsed', () => {
    const { result, rerender, setNow } = setup({
      value: 'data',
      loading: false,
      minVisibleMs: 100,
    })
    rerender({ value: 'data', loading: true, minVisibleMs: 100 })
    setNow(2_000)
    rerender({ value: 'data', loading: false, minVisibleMs: 100 })

    act(() => vi.runOnlyPendingTimers())
    expect(result.current).toBe(false)
  })

  it('does not show a handoff for a value change while idle', () => {
    const { result, rerender } = setup({ value: 'schema', loading: false })

    rerender({ value: 'data', loading: false })

    expect(result.current).toBe(false)
  })

  it('cancels a pending hide when another load starts', () => {
    const { result, rerender, setNow, unmount } = setup({
      value: 'data',
      loading: false,
      minVisibleMs: 100,
    })
    rerender({ value: 'data', loading: true, minVisibleMs: 100 })
    setNow(1_050)
    rerender({ value: 'data', loading: false, minVisibleMs: 100 })
    rerender({ value: 'data', loading: true, minVisibleMs: 100 })

    act(() => vi.advanceTimersByTime(1_000))
    expect(result.current).toBe(true)
    unmount()
  })
})
