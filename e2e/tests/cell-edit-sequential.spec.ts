/**
 * E2E: Sequential edit-Apply stress test
 *
 * Verifies that many consecutive edit→Apply→reload cycles do not
 * accumulate stale state that causes a later update to silently fail.
 */
import { test, expect } from '../fixtures'

async function editCellAndApply(
  page,
  sessionId: string,
  rowIndex: number,
  newValue: string
) {
  const cell = page.locator('.ag-row').nth(rowIndex).locator('[col-id="price"]')
  const editor = page.locator('.ag-text-field-input')
  await expect(cell).toBeVisible({ timeout: 10_000 })
  await cell.scrollIntoViewIfNeeded()
  await cell.click()
  await cell.dblclick()
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await editor.fill(newValue)
  await editor.press('Enter')

  // The staged-change footer opens the review dialog; the write only happens
  // when the dialog is confirmed.
  const applyButton = page.getByRole('button', { name: /^Apply \(/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click()

  const reviewDialog = page.getByRole('dialog', { name: 'Review Staged Changes' })
  const reviewTitle = page.locator('#lagun-overlays').getByText('Review Staged Changes', { exact: true })
  await expect(reviewDialog).toBeVisible({ timeout: 5000 })
  const rowUpdate = page.waitForResponse(response =>
    response.request().method() === 'POST' &&
    response.url().includes(`/api/v1/sessions/${sessionId}/row-update`)
  )
  await reviewDialog.getByRole('button', { name: 'Apply Changes' }).click()
  expect((await rowUpdate).ok()).toBe(true)
  await expect(reviewDialog).toBeHidden()
  await expect(reviewTitle).toHaveCount(0)
  await expect(applyButton).toBeHidden()

  const saved = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'SELECT price FROM e2e_test.products WHERE id = 1' },
  })
  expect(saved.ok()).toBe(true)
  expect((await saved.json()).rows).toEqual([[newValue]])
  await expect(cell).toHaveText(newValue)
}

test('ten sequential edit-Apply cycles followed by an 11th that also works', async ({ page, sessionId }) => {
  await page.goto('/')

  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  for (let i = 0; i < 10; i++) {
    await editCellAndApply(page, sessionId, 0, (10.0 + i * 0.01).toFixed(2))
  }

  await editCellAndApply(page, sessionId, 0, '99.99')
})
