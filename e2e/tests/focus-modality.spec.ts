import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../fixtures'

test.beforeEach(async ({ page, sessionId }) => {
  void sessionId
  await page.goto('/')
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByRole('button', { name: 'e2e_test', exact: true }).click()
  await page.getByRole('button', { name: 'products', exact: true }).click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  await expect(page.locator('.ag-center-cols-container .ag-row').first()).toBeVisible()
})

async function hasVisibleFocusRing(control: Locator) {
  return control.evaluate(element => {
    const style = getComputedStyle(element)
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      && !/rgba\([^)]*,\s*0\)/.test(style.outlineColor)) return true
    // Ignore transparent outlines and zero-sized or transparent shadows.
    return style.boxShadow.split(/,(?![^(]*\))/).some(part => {
      if (/rgba\([^)]*,\s*0\)/.test(part)) return false
      const lengths = part.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? []
      return lengths.some(value => parseFloat(value) !== 0)
    })
  })
}

async function expectModifiersToKeepPointerFocus(page: Page, control: Locator) {
  await expect(control).toBeFocused()
  const pointerBorder = await control.evaluate(element => getComputedStyle(element).borderColor)
  for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
    await page.keyboard.down(key)
    await expect(control).toBeFocused()
    await expect.poll(() => hasVisibleFocusRing(control)).toBe(false)
    await expect.poll(() => control.evaluate(element => getComputedStyle(element).borderColor)).toBe(pointerBorder)
    await page.keyboard.up(key)
    await expect.poll(() => hasVisibleFocusRing(control)).toBe(false)
  }
}

test('modifier keys do not reveal rings on pointer-focused sidebar, tab, or toolbar controls', async ({ page }) => {
  for (const control of [
    page.getByRole('button', { name: 'products', exact: true }),
    page.getByRole('tab', { name: /products/ }),
    page.getByRole('button', { name: 'Data', exact: true }),
  ]) {
    await control.click()
    await expectModifiersToKeepPointerFocus(page, control)
  }
})

test('Tab, Shift+Tab, and arrow navigation still reveal keyboard focus', async ({ page }) => {
  const table = page.getByRole('button', { name: 'products', exact: true })
  await table.click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Bookmark e2e_test.products' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(table).toBeFocused()
  await expect.poll(() => hasVisibleFocusRing(table)).toBe(true)
  await page.keyboard.down('Shift')
  await expect.poll(() => hasVisibleFocusRing(table)).toBe(true)
  await page.keyboard.up('Shift')

  const tab = page.getByRole('tab', { name: /products/ })
  await tab.click()
  await page.keyboard.press('ArrowRight')
  await expect(tab).toBeFocused()
  await expect.poll(() => hasVisibleFocusRing(tab)).toBe(true)
  await tab.click()
  await expect.poll(() => hasVisibleFocusRing(tab)).toBe(false)
})

test('text inputs keep focus feedback and pointer-selected dropdowns do not retain rings', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Search all columns', exact: true })
  const field = page.locator('.lagun-table-search')
  const unfocusedBorder = await field.evaluate(element => getComputedStyle(element).borderColor)
  await input.click()
  await expect(input).toBeFocused()
  await expect.poll(() => field.evaluate(element => getComputedStyle(element).borderColor)).not.toBe(unfocusedBorder)
  await page.keyboard.down('Shift')
  await expect.poll(() => field.evaluate(element => getComputedStyle(element).borderColor)).not.toBe(unfocusedBorder)
  await page.keyboard.up('Shift')

  const limit = page.getByRole('button', { name: 'Row limit', exact: true })
  await limit.click()
  await page.getByRole('option', { name: '1,000', exact: true }).click()
  await expect(limit).toBeFocused()
  await expect.poll(() => hasVisibleFocusRing(limit)).toBe(false)
  await expectModifiersToKeepPointerFocus(page, limit)
})
