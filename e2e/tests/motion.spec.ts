import { expect, test } from '@playwright/test'

test.describe('motion system', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Query Log')).toBeVisible()
  })

  test('keeps modal semantics immediate through animated exit', async ({ page }) => {
    await page.getByRole('button', { name: 'New Query', exact: true }).click()
    const tab = page.getByRole('tab', { name: /Query/ }).first()
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()

    const dialog = page.getByRole('dialog', { name: 'Rename Tab' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#lagun-overlays [aria-hidden="true"]')).toHaveCount(0, { timeout: 1000 })
  })

  test('expands and reverses the Query Log without losing its endpoint', async ({ page }) => {
    const panel = page.getByText('Query Log').locator('xpath=../..')
    await page.getByText('Query Log').click()
    await page.getByText('Query Log').click()
    await page.getByText('Query Log').click()
    await expect(panel).toHaveCSS('height', '208px')
    await page.getByText('Query Log').click()
    await expect(panel).toHaveCSS('height', '28px')
  })

  test('honors reduced motion while keeping state changes usable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'New Query', exact: true }).click()
    const tab = page.getByRole('tab', { name: /Query/ }).first()
    await expect(tab).toBeVisible()
    await tab.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Tab actions' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Tab actions' })).toHaveCount(0)
  })
})
