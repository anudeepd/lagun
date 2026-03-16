/**
 * E2E: Inline cell editing
 *
 * Tests that a user can click a cell in the table Data view,
 * type a new value, and the change persists after the grid reloads.
 *
 * Cell editing is only available in the TableTab (schema-tree → Data view),
 * not in the plain query result grid.
 */
import { test, expect } from '../fixtures'

test('edit a cell and verify the change persists', async ({ page, sessionId }) => {
  await page.goto('/')

  // Activate the session to show the schema tree
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()

  // Expand the e2e_test database node in the schema tree
  await page.getByText('e2e_test').click()

  // Click the products table to open a table tab
  await page.getByText('products').click()

  // Switch to Data view
  await page.getByRole('button', { name: 'Data', exact: true }).click()

  // Wait for rows to load
  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  // Single-click the price cell in the first row (grid uses singleClickEdit)
  const priceCell = page.locator('.ag-row').first().locator('[col-id="price"]')
  await priceCell.click()

  // Type the new value into the cell editor
  const cellEditor = page.locator('.ag-cell-editor input, .ag-cell-edit-input')
  await cellEditor.press('Control+a')
  await cellEditor.fill('99.99')
  await cellEditor.press('Enter')

  // The grid reloads after a successful update — verify the new value appears
  await expect(page.locator('.ag-cell', { hasText: '99.99' })).toBeVisible({ timeout: 10_000 })
})
