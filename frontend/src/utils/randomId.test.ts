import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses randomUUID when the browser provides it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-from-browser' })

    expect(randomId()).toBe('uuid-from-browser')
  })

  it('builds a UUID from getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0)
        return bytes
      },
    })

    expect(randomId()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('keeps producing distinct ids when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)

    const first = randomId()
    const second = randomId()

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[a-z0-9]+-[0-9a-z]+$/)
  })
})
