import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('platform key labels', () => {
  it('chooses the command glyph for Apple platforms', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.resetModules()

    const platform = await import('../../utils/platform')

    expect(platform.isMac).toBe(true)
    expect(platform.modKey).toBe('⌘')
  })

  it('chooses Ctrl for non-Apple platforms', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    vi.resetModules()

    const platform = await import('../../utils/platform')

    expect(platform.isMac).toBe(false)
    expect(platform.modKey).toBe('Ctrl')
  })

  it('falls back to Ctrl when there is no browser navigator', async () => {
    vi.stubGlobal('navigator', undefined)
    vi.resetModules()

    const platform = await import('../../utils/platform')

    expect(platform.isMac).toBe(false)
    expect(platform.modKey).toBe('Ctrl')
  })
})
