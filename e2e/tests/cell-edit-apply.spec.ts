/**
 * E2E: Edit → Apply → Verify flow
 *
 * Tests the actual frontend code path: a user edits a cell in the Data view,
 * the orange highlight appears, they click "Apply", the grid reloads,
 * and the new value is persisted.
 */
import { test, expect } from '../fixtures'

test('edit a cell, click Apply, and verify persistence', async ({ page, sessionId }) => {
  await page.goto('/')

  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  const priceCell = page.locator('.ag-row').first().locator('[col-id="price"]')
  await priceCell.dblclick()

  const cellEditor = page.locator('.ag-text-field-input')
  await cellEditor.waitFor({ state: 'visible', timeout: 5000 })
  await cellEditor.fill('99.99')
  await cellEditor.press('Enter')

  const applyButton = page.getByRole('button', { name: /Apply/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click()

  await expect(page.locator('.ag-cell', { hasText: '99.99' })).toBeVisible({ timeout: 10_000 })

  // Verify the orange pending-change highlight is gone after the reload
  await expect(page.locator('.ag-cell', { hasText: '99.99' })).toHaveCSS('background-color', /^(rgba\(0, 0, 0, 0\)|transparent|#0f172a)$/i, { timeout: 5000 })
})
