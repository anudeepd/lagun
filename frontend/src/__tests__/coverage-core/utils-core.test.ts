import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFocusModality } from '../../utils/focusModality'
import { buildResultGridRowId } from '../../utils/rowIdentity'
import {
  FILTER_HISTORY_LIMIT,
  loadFilterHistory,
  recordFilterHistory,
} from '../../utils/filterHistory'
import { clipboardWrite } from '../../utils/clipboard'
import {
  STANDARD_SCROLLBARS_ATTRIBUTE,
  installScrollbarFallback,
} from '../../utils/scrollbarFallback'
import { startAuthIdleTimer } from '../../utils/authIdleTimer'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(STANDARD_SCROLLBARS_ATTRIBUTE)
  document.documentElement.removeAttribute('data-focus-modality')
  localStorage.clear()
})

describe('focus modality', () => {
  it('distinguishes pointer input from real keyboard navigation and cleans up', () => {
    const root = document.documentElement
    const uninstall = installFocusModality()

    expect(root.dataset.focusModality).toBe('keyboard')

    document.dispatchEvent(new Event('pointerdown'))
    expect(root.dataset.focusModality).toBe('pointer')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(root.dataset.focusModality).toBe('keyboard')

    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    expect(root.dataset.focusModality).toBe('pointer')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', metaKey: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', altKey: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'CapsLock' }))
    expect(root.dataset.focusModality).toBe('pointer')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    expect(root.dataset.focusModality).toBe('keyboard')

    uninstall()
    expect(root.dataset.focusModality).toBeUndefined()
    document.dispatchEvent(new Event('pointerdown'))
    expect(root.dataset.focusModality).toBeUndefined()
  })

  it('installs on an explicit document', () => {
    const explicit = document.implementation.createHTMLDocument('explicit')
    const uninstall = installFocusModality(explicit)

    explicit.dispatchEvent(new Event('pointerdown'))
    expect(explicit.documentElement.dataset.focusModality).toBe('pointer')
    uninstall()
    expect(explicit.documentElement.dataset.focusModality).toBeUndefined()
  })
})

describe('result-grid row identity', () => {
  it('uses every value type in a keyed identity', () => {
    const row = {
      id: 7,
      nullable: null,
      missing: undefined,
      label: 'alpha',
      active: true,
    }
    const keyColumns = ['id', 'nullable', 'missing', 'label', 'active']

    const first = buildResultGridRowId(row, 0, keyColumns)
    const second = buildResultGridRowId({ ...row }, 42, keyColumns)

    expect(first).toMatch(/^key:[0-9a-f]{16}$/)
    expect(second).toBe(first)
    expect(buildResultGridRowId({ ...row, id: 8 }, 0, keyColumns)).not.toBe(first)
    expect(buildResultGridRowId({ ...row, nullable: 'null' }, 0, keyColumns)).not.toBe(first)
    expect(buildResultGridRowId({ ...row, missing: 'undefined' }, 0, keyColumns)).not.toBe(first)
  })

  it('adds the row index only when it is part of the selected identity', () => {
    const unkeyedFirst = buildResultGridRowId({ one: 1 }, 3, [])
    const unkeyedSecond = buildResultGridRowId({ one: 1 }, 4, [])

    expect(unkeyedFirst).toMatch(/^row:[0-9a-f]{16}:3$/)
    expect(unkeyedSecond).not.toBe(unkeyedFirst)
    expect(buildResultGridRowId({ id: 1 }, 3, ['id'], true)).toMatch(/:3$/)
    expect(buildResultGridRowId({ id: 1 }, 3, ['id'], false)).toMatch(/^key:/)
  })
})

describe('filter history edge cases', () => {
  it('tolerates corrupt storage and missing table keys', () => {
    localStorage.setItem('lagun-filter-history', '{broken')
    expect(loadFilterHistory('db', 'users')).toEqual([])
    expect(recordFilterHistory('db', 'users', 'id = 1')).toEqual(['id = 1'])
    expect(loadFilterHistory('db', 'users')).toEqual(['id = 1'])
  })

  it('ignores calls without both table identifiers', () => {
    expect(recordFilterHistory(undefined, 'users', 'id = 1')).toEqual([])
    expect(recordFilterHistory('db', undefined, 'id = 1')).toEqual([])
    expect(loadFilterHistory('db', undefined)).toEqual([])
    expect(loadFilterHistory(undefined, 'users')).toEqual([])
  })

  it('keeps history in memory when storage refuses the write', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(recordFilterHistory('db', 'users', 'status = 1')).toEqual(['status = 1'])
  })

  it('creates a database bucket and applies the documented cap', () => {
    const additions = 4
    for (let index = 0; index < FILTER_HISTORY_LIMIT + additions; index += 1) {
      recordFilterHistory('analytics', 'events', `kind = ${index}`)
    }

    const history = loadFilterHistory('analytics', 'events')
    expect(history).toHaveLength(FILTER_HISTORY_LIMIT)
    expect(history[0]).toBe(`kind = ${FILTER_HISTORY_LIMIT + additions - 1}`)
  })
})

describe('clipboard fallbacks', () => {
  function installCopyCommand(
    implementation: (event: Event) => void,
    ok = true,
  ) {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        const event = new Event('copy', { bubbles: true, cancelable: true })
        implementation(event)
        document.dispatchEvent(event)
        return ok
      }),
    })
  }

  it('reports a missing legacy command', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })

    await expect(clipboardWrite('copy me')).rejects.toThrow('Clipboard API is unavailable')
  })

  it('reports a copy command that never delivers clipboard data', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    installCopyCommand(() => {})

    await expect(clipboardWrite('copy me')).rejects.toThrow('Copy failed')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('keeps the selection available when copy reports success without a payload', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    installCopyCommand(event => {
      Object.defineProperty(event, 'clipboardData', { value: null })
    })
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(document.body)
    selection?.removeAllRanges()
    selection?.addRange(range)

    await expect(clipboardWrite('copy me')).rejects.toThrow('Copy failed')
    expect(selection?.rangeCount).toBe(1)
  })

  it('restores a previous range after a successful legacy copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    installCopyCommand(event => {
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: vi.fn() },
      })
    })
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(document.body)
    selection?.removeAllRanges()
    selection?.addRange(range)

    await clipboardWrite('copy me')

    expect(selection?.rangeCount).toBe(1)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('uses the legacy path when a clipboard object has no writeText method', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} })
    const setData = vi.fn()
    installCopyCommand(event => {
      Object.defineProperty(event, 'clipboardData', { value: { setData } })
    })

    await clipboardWrite('copy me')

    expect(setData).toHaveBeenCalledWith('text/plain', 'copy me')
  })

  it('copies without a document selection to preserve', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    installCopyCommand(event => {
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: vi.fn() },
      })
    })
    vi.spyOn(document, 'getSelection').mockReturnValue(null)

    await expect(clipboardWrite('copy me')).resolves.toBeUndefined()
  })
})

describe('scrollbar fallback branch selection', () => {
  it('leaves a browser that honors the probe rule unmarked', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(105)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)

    installScrollbarFallback()

    expect(document.documentElement.hasAttribute(STANDARD_SCROLLBARS_ATTRIBUTE)).toBe(false)
    expect(document.querySelector('[data-scrollbar-probe]')).toBeNull()
    expect(document.querySelectorAll('style')).toHaveLength(0)
  })
})

describe('auth idle timer option and target branches', () => {
  function fakeWindow() {
    const timers = new Map<number, () => void>()
    let nextTimer = 1
    const target = {
      setTimeout: vi.fn((callback: () => void) => {
        const id = nextTimer
        nextTimer += 1
        timers.set(id, callback)
        return id
      }),
      clearTimeout: vi.fn((id: number) => {
        timers.delete(id)
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      document: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    }
    return { target, timers }
  }

  it('does nothing when LDAP idle enforcement is off', () => {
    const onIdle = vi.fn()
    const cleanup = startAuthIdleTimer({ enabled: false, idleTimeoutSeconds: 2, onIdle })

    expect(cleanup).toBeTypeOf('function')
    expect(onIdle).not.toHaveBeenCalled()
    cleanup()
  })

  it('wires all activity and resume events on a supplied target', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { target, timers } = fakeWindow()
    const onIdle = vi.fn()
    const cleanup = startAuthIdleTimer({
      enabled: true,
      idleTimeoutSeconds: 2,
      onIdle,
      target: target as unknown as Window,
    })

    expect(target.addEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), { passive: true })
    expect(target.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { passive: true })
    expect(target.addEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function), { passive: true })
    expect(target.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: true })
    expect(target.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function), { passive: true })
    expect(target.addEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function), { passive: true })
    expect(target.document.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function), { passive: true })
    expect(timers.size).toBe(1)

    cleanup()
    expect(target.clearTimeout).toHaveBeenCalled()
    expect(target.removeEventListener).toHaveBeenCalledTimes(6)
    expect(target.document.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('expires once and ignores later activity when the timer cannot clear itself', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { target, timers } = fakeWindow()
    target.setTimeout.mockImplementation((callback: () => void) => {
      timers.set(99, callback)
      return undefined as unknown as number
    })
    const onIdle = vi.fn()
    startAuthIdleTimer({
      enabled: true,
      idleTimeoutSeconds: 2,
      onIdle,
      target: target as unknown as Window,
    })

    vi.setSystemTime(3_001)
    timers.get(99)?.()
    timers.get(99)?.()
    expect(onIdle).toHaveBeenCalledOnce()
    expect(target.clearTimeout).not.toHaveBeenCalled()

    target.addEventListener.mock.calls
      .filter(([event]) => event === 'keydown')
      .at(0)?.[1]()
    expect(onIdle).toHaveBeenCalledOnce()
  })
})
