import { describe, it, expect, afterEach } from 'vitest'
import { engineStylesWebkitScrollbars, installScrollbarFallback, STANDARD_SCROLLBARS_ATTRIBUTE } from '../../utils/scrollbarFallback'

describe('engineStylesWebkitScrollbars', () => {
  it('accepts the gutter the probe rule asked for, with room for a track border', () => {
    expect(engineStylesWebkitScrollbars(4)).toBe(true)
    expect(engineStylesWebkitScrollbars(5)).toBe(true)
  })

  it('rejects a default platform scrollbar', () => {
    // 14px is what Firefox and Waterfox draw when the rule is ignored.
    expect(engineStylesWebkitScrollbars(14)).toBe(false)
    expect(engineStylesWebkitScrollbars(17)).toBe(false)
  })

  it('rejects overlay scrollbars, which take no space but are still not the rule', () => {
    expect(engineStylesWebkitScrollbars(0)).toBe(false)
  })
})

describe('installScrollbarFallback', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(STANDARD_SCROLLBARS_ATTRIBUTE)
    document.querySelector('[data-scrollbar-probe]')?.remove()
  })

  it('marks the document and leaves nothing behind in the DOM', () => {
    // jsdom has no layout, so the probe measures 0: the branch that matters for
    // Firefox and Waterfox.
    installScrollbarFallback(document)

    expect(document.documentElement.getAttribute(STANDARD_SCROLLBARS_ATTRIBUTE)).toBe('standard')
    expect(document.querySelector('[data-scrollbar-probe]')).toBeNull()
    expect(document.querySelectorAll('style').length).toBe(0)
  })
})
