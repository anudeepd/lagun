/**
 * E2E: Query execution flow
 *
 * Tests that a user can select a database, type a query in the editor,
 * run it, and see results in the grid.
 */
import { test, expect, openSessionQueryTab } from '../fixtures'

test('run a SELECT query and see results in the grid', async ({ page, sessionId }) => {
  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  // Type a query in the CodeMirror editor
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('SELECT * FROM e2e_test.products')

  // Run the query
  await page.keyboard.press('Control+Enter')

  // Wait for the ag-grid to render rows
  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  // Should have 3 rows (Widget, Gadget, Doohickey)
  const rows = page.locator('.ag-row')
  await expect(rows).toHaveCount(3)

  // Column headers should include 'title' and 'price'
  await expect(page.locator('.ag-header-cell-text', { hasText: 'title' })).toBeVisible()
  await expect(page.locator('.ag-header-cell-text', { hasText: 'price' })).toBeVisible()
})

test('run a COUNT query and see scalar result', async ({ page, sessionId }) => {
  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('SELECT COUNT(*) FROM e2e_test.products')
  await page.keyboard.press('Control+Enter')

  await expect(page.locator('.ag-cell', { hasText: '3' })).toBeVisible({ timeout: 10_000 })
})
