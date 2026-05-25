/**
 * E2E: Stress tests for inline cell editing
 *
 * Rapidly edit multiple cells and click Apply before all blurs have fired,
 * simulating the race condition where the grid still has an in-progress edit.
 */
import { test, expect } from '../fixtures'

test('Apply while a second cell editor is still open commits the in-flight edit', async ({ page, sessionId }) => {
  await page.goto('/')

  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  // Edit Widget's price and commit it so the Apply button appears
  const widgetPrice = page.locator('.ag-row').nth(0).locator('[col-id="price"]')
  await widgetPrice.dblclick()
  const editor0 = page.locator('.ag-text-field-input')
  await editor0.waitFor({ state: 'visible', timeout: 5000 })
  await editor0.fill('11.11')
  await editor0.press('Enter')

  // Now edit Gadget's price but do NOT press Enter — leave the editor open
  const gadgetPrice = page.locator('.ag-row').nth(1).locator('[col-id="price"]')
  await gadgetPrice.dblclick()
  const editor1 = page.locator('.ag-text-field-input')
  await editor1.waitFor({ state: 'visible', timeout: 5000 })
  await editor1.fill('22.22')

  // Click Apply while Gadget's editor is still open.
  // The stopEditing() guard in handleApplyChanges forces the commit.
  const applyButton = page.getByRole('button', { name: /Apply/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click()

  // Both values should persist after the grid reloads
  await expect(page.locator('.ag-cell', { hasText: '11.11' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ag-cell', { hasText: '22.22' })).toBeVisible({ timeout: 10_000 })
})

test('rapid multi-cell edits followed by a single Apply persist all changes', async ({ page, sessionId }) => {
  await page.goto('/')

  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  const widgetPrice = page.locator('.ag-row').nth(0).locator('[col-id="price"]')
  await widgetPrice.dblclick()
  const editor0 = page.locator('.ag-text-field-input')
  await editor0.waitFor({ state: 'visible', timeout: 5000 })
  await editor0.fill('11.11')
  await editor0.press('Enter')

  const gadgetPrice = page.locator('.ag-row').nth(1).locator('[col-id="price"]')
  await gadgetPrice.dblclick()
  const editor1 = page.locator('.ag-text-field-input')
  await editor1.waitFor({ state: 'visible', timeout: 5000 })
  await editor1.fill('22.22')
  await editor1.press('Enter')

  const applyButton = page.getByRole('button', { name: /Apply/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click()

  await expect(page.locator('.ag-cell', { hasText: '11.11' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ag-cell', { hasText: '22.22' })).toBeVisible({ timeout: 10_000 })
})
