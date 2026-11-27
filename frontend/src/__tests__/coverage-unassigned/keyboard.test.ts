import { describe, expect, it } from 'vitest'
import { isImeComposing } from '../../utils/keyboard'

describe('isImeComposing', () => {
  it('accepts modern and legacy IME markers and rejects ordinary keys', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true)
    expect(isImeComposing({ keyCode: 229 })).toBe(true)
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
