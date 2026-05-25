/**
 * E2E: Sequential edit-Apply stress test
 *
 * Verifies that many consecutive edit→Apply→reload cycles do not
 * accumulate stale state that causes a later update to silently fail.
 */
import { test, expect } from '../fixtures'

async function editCellAndApply(
  page,
  rowIndex: number,
  newValue: string
) {
  const cell = page.locator('.ag-row').nth(rowIndex).locator('[col-id="price"]')
  await cell.dblclick()

  const editor = page.locator('.ag-text-field-input')
  await editor.waitFor({ state: 'visible', timeout: 5000 })
  await editor.fill(newValue)
  await editor.press('Enter')

  const applyButton = page.getByRole('button', { name: /Apply/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click({ force: true })

  await expect(page.locator('.ag-cell', { hasText: newValue })).toBeVisible({ timeout: 10_000 })
}

test('ten sequential edit-Apply cycles followed by an 11th that also works', async ({ page, sessionId }) => {
  await page.goto('/')

  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  for (let i = 0; i < 10; i++) {
    await editCellAndApply(page, 0, (10.0 + i * 0.01).toFixed(2))
  }

  await editCellAndApply(page, 0, '99.99')
})
