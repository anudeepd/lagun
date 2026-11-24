import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardWrite } from '../../utils/clipboard'

afterEach(() => {
  vi.restoreAllMocks()
})

function setClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  })
}

function mockExecCommand(ok = true) {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => {
      if (ok) {
        const event = new Event('copy', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', {
          value: { setData: vi.fn() },
        })
        document.dispatchEvent(event)
      }
      return ok
    }),
  })
  return vi.mocked(document.execCommand)
}

describe('clipboardWrite', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = mockExecCommand()
    setClipboard(writeText)

    await clipboardWrite('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back when Safari-style navigator clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const execCommand = mockExecCommand()
    setClipboard(writeText)

    await clipboardWrite('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('uses fallback when navigator.clipboard is unavailable', async () => {
    const execCommand = mockExecCommand()
    setClipboard(undefined)

    await clipboardWrite('hello')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('passes large text through the copy event instead of putting it in the DOM', async () => {
    setClipboard(undefined)
    const text = Array.from({ length: 10_000 }, (_, index) => `INSERT INTO t VALUES (${index});`).join('\n')
    const clipboardData = {
      value: '',
      setData(_type: string, value: string) { this.value = value },
      getData() { return this.value },
    }
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        const event = new Event('copy', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'clipboardData', { value: clipboardData })
        document.dispatchEvent(event)
        return true
      }),
    })

    await clipboardWrite(text)

    expect(clipboardData.getData()).toBe(text)
  })

  it('rejects when the legacy copy command is refused', async () => {
    setClipboard(undefined)
    mockExecCommand(false)

    await expect(clipboardWrite('hello')).rejects.toThrow('Copy failed')
  })
})
