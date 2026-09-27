import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import GridContextMenu from '../../components/editor/GridContextMenu'

const VIEWPORT_WIDTH = 1024
const VIEWPORT_HEIGHT = 768
// Size of the menu's layout box, and the rect motion reports while its enter
// animation still has scale(0.9) applied.
const MENU_WIDTH = 200
const MENU_HEIGHT = 100
const ENTER_SCALE = 0.9

const originalRects = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  getBoundingClientRect: HTMLElement.prototype.getBoundingClientRect,
}

describe('GridContextMenu viewport clamp', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT_WIDTH, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_HEIGHT, configurable: true })
    // jsdom reports every layout box as 0, so pin the layout box and make
    // getBoundingClientRect() report the scaled rect instead. A clamp that
    // measures the rect is ~10% off and lets the menu overflow; only one that
    // measures the layout box (offsetWidth/offsetHeight) is correct.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => MENU_WIDTH })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => MENU_HEIGHT })
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: MENU_WIDTH * ENTER_SCALE,
      bottom: MENU_HEIGHT * ENTER_SCALE,
      width: MENU_WIDTH * ENTER_SCALE,
      height: MENU_HEIGHT * ENTER_SCALE,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    for (const [key, descriptor] of Object.entries(originalRects)) {
      if (key === 'getBoundingClientRect') continue
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    }
    HTMLElement.prototype.getBoundingClientRect = originalRects.getBoundingClientRect
  })

  it('clamps a menu opened at the bottom-right corner inside the viewport', () => {
    render(
      <GridContextMenu
        x={VIEWPORT_WIDTH - 10}
        y={VIEWPORT_HEIGHT - 10}
        items={[{ type: 'item', label: 'Copy cell', onClick: () => {} }]}
        onClose={() => {}}
      />,
    )

    const menu = screen.getByRole('menu', { name: 'Grid actions' })
    expect(menu.style.left).toBe(`${VIEWPORT_WIDTH - MENU_WIDTH - 8}px`)
    expect(menu.style.top).toBe(`${VIEWPORT_HEIGHT - MENU_HEIGHT - 8}px`)
  })

  it('keeps the 8px floor when the menu is opened in the top-left corner', () => {
    render(
      <GridContextMenu
        x={-40}
        y={-40}
        items={[{ type: 'item', label: 'Copy cell', onClick: () => {} }]}
        onClose={() => {}}
      />,
    )

    const menu = screen.getByRole('menu', { name: 'Grid actions' })
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('8px')
  })
})
