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
    value: vi.fn().mockReturnValue(ok),
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
})
