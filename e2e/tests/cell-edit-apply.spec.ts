/**
 * E2E: Edit → Apply → Verify flow
 *
 * Tests the actual frontend code path: a user edits a cell in the Data view,
 * changes are staged, they click "Apply", the grid reloads,
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

  // The staged-change footer opens the review dialog; the write only happens
  // when the dialog is confirmed.
  const applyButton = page.getByRole('button', { name: /^Apply \(/ })
  await expect(applyButton).toBeVisible({ timeout: 5000 })
  await applyButton.click()

  const reviewDialog = page.getByRole('dialog', { name: 'Review Staged Changes' })
  await expect(reviewDialog).toBeVisible({ timeout: 5000 })
  await reviewDialog.getByRole('button', { name: 'Apply Changes' }).click()

  await expect(page.locator('.ag-cell', { hasText: '99.99' })).toBeVisible({ timeout: 10_000 })

  await expect(applyButton).toBeHidden()
  const saved = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'SELECT price FROM e2e_test.products WHERE id = 1' },
  })
  expect((await saved.json()).rows).toEqual([['99.99']])
})

test('native date editing cancels cleanly and saves the exact calendar date without runtime errors', async ({ page, sessionId }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const query = async (sql: string) => {
    const response = await page.request.post(`/api/v1/sessions/${sessionId}/query`, { data: { sql } })
    expect(response.ok()).toBe(true)
    const result = await response.json()
    expect(result.error).toBeNull()
    return result
  }
  await query("ALTER TABLE e2e_test.products ADD COLUMN release_date DATE NOT NULL DEFAULT '2026-10-14'")
  await page.goto('/')
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test', { exact: true }).click()
  await page.getByRole('button', { name: 'products', exact: true }).click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  const dateCell = page.locator('.ag-center-cols-container .ag-row').first().locator('[col-id="release_date"]')
  await expect(dateCell).toHaveText('2026-10-14')
  await dateCell.dblclick()
  const editor = page.locator('.ag-cell-inline-editing input[type="date"]')
  await expect(editor).toHaveValue('2026-10-14')
  await editor.fill('2026-11-03')
  await editor.press('Escape')
  await expect(dateCell).toHaveText('2026-10-14')
  await expect(page.getByRole('button', { name: /^Apply \(/ })).toBeHidden()

  await dateCell.dblclick()
  await editor.fill('2026-11-03')
  await editor.press('Enter')
  await expect(dateCell).toHaveText('2026-11-03')
  expect((await query('SELECT release_date FROM e2e_test.products WHERE id = 1')).rows).toEqual([['2026-10-14']])
  await page.getByRole('button', { name: 'Apply (1)', exact: true }).click()
  await page.getByRole('dialog', { name: 'Review Staged Changes' }).getByRole('button', { name: 'Apply Changes' }).click()
  await expect(page.getByRole('button', { name: /^Apply \(/ })).toBeHidden()
  expect((await query('SELECT release_date FROM e2e_test.products WHERE id = 1')).rows).toEqual([['2026-11-03']])
  await page.reload()
  await expect(dateCell).toHaveText('2026-11-03')
  expect(errors).toEqual([])
})
