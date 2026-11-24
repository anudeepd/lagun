import { describe, expect, it } from 'vitest'
import { isImeComposing } from './keyboard'

describe('isImeComposing', () => {
  it('recognises an active browser composition', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true)
  })

  it('recognises the Safari process-key marker', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('reads a React synthetic event through its native event', () => {
    expect(isImeComposing({
      nativeEvent: { isComposing: true, keyCode: 13 },
    })).toBe(true)
  })

  it('allows a normal Enter key', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
