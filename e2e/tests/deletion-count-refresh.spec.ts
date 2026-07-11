/**
 * E2E: Deletion count refresh in ResultToolbar
 *
 * Tests that the row count in the ResultToolbar updates immediately
 * after deleting rows in the Data tab, without waiting for server refresh.
 *
 * Relies on the optimistic state update in TabContent.handleDeleteRows
 * which filters deleted rows out of the local result state and updates
 * row_count, then fires loadData() as a fire-and-forget refresh.
 */
import { test, expect } from '../fixtures'

const INITIAL_ROWS = 3   // seeded by seedDatabase in the fixture
const EXTRA_ROWS = 7     // inserted in beforeEach for larger dataset
const TOTAL_ROWS = INITIAL_ROWS + EXTRA_ROWS

function rowCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`
}

async function waitForRefreshToSettle(page) {
  await expect
    .poll(async () => page.locator('.animate-spin').evaluateAll(nodes =>
      nodes.filter(node => {
        const style = window.getComputedStyle(node)
        const box = node.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0
      }).length
    ), { timeout: 15_000 })
    .toBe(0)
}

test.describe('Deletion count refresh', () => {
  test.beforeEach(async ({ page, sessionId }) => {
    // Insert additional rows so we have enough to delete and verify
    for (let i = 0; i < EXTRA_ROWS; i++) {
      await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
        data: {
          sql: `INSERT INTO e2e_test.products (title, price) VALUES ('Product ${i}', ${9.99 + i})`,
        },
      })
    }

    await page.goto('/')

    // Activate the test session in the sidebar
    await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
    await expect(page.getByText('e2e_test')).toBeVisible()

    // Expand the e2e_test database in the schema tree
    await page.getByRole('button', { name: 'e2e_test' }).click()
    await expect(page.getByRole('button', { name: 'products' })).toBeVisible()

    // Open the products table (opens a table tab)
    await page.getByRole('button', { name: 'products' }).click()

    // Switch from Schema view to Data view
    await page.getByRole('button', { name: 'Data', exact: true }).click()

    // Wait for the AG Grid to render rows
    await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })
  })

  test('Deletion immediately updates row count in toolbar', async ({ page }) => {
    // Verify initial row count in the ResultToolbar
    await expect(page.getByText(rowCountLabel(TOTAL_ROWS))).toBeVisible({ timeout: 5_000 })

    // Select first 2 rows via their checkboxes
    // Use .ag-row to scope to data rows only (header has .ag-header-row)
    const rowCheckboxes = page.locator('.ag-row .ag-checkbox-input')
    await rowCheckboxes.nth(0).click()
    await rowCheckboxes.nth(1).click()

    // Right-click on a cell in the first row to open the context menu
    await page.locator('.ag-row').nth(0).locator('.ag-cell').nth(1).click({ button: 'right' })

    // Context menu appears with "Delete N rows" option
    const deleteBtn = page.locator('div.z-\\[9999\\] button', { hasText: 'Delete 2 rows' })
    await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
    await deleteBtn.click({ force: true })

    // Context menu closes, optimistic update fires immediately.
    // Assert the ResultToolbar count shows TOTAL_ROWS - 2
    // (no waiting for the server refresh from loadData)
    const expectedAfterFirst = TOTAL_ROWS - 2
    await expect(page.getByText(rowCountLabel(expectedAfterFirst))).toBeVisible({ timeout: 5_000 })

    // Assert deleted rows are no longer visible in the grid
    await expect(page.locator('.ag-row')).toHaveCount(expectedAfterFirst)
  })

  test('Rapid successive deletions show correct final count', async ({ page }) => {
    // Verify initial row count
    await expect(page.getByText(rowCountLabel(TOTAL_ROWS))).toBeVisible({ timeout: 5_000 })

    // --- First deletion: select and delete 2 rows ---
    const rowCheckboxes = page.locator('.ag-row .ag-checkbox-input')
    await rowCheckboxes.nth(0).click()
    await rowCheckboxes.nth(1).click()
    await page.locator('.ag-row').nth(0).locator('.ag-cell').nth(1).click({ button: 'right' })

    const firstDeleteBtn = page.locator('div.z-\\[9999\\] button', { hasText: /Delete/ })
    await expect(firstDeleteBtn).toBeVisible({ timeout: 3_000 })
    await firstDeleteBtn.click()

    // Verify count dropped by 2 after first deletion
    const afterFirst = TOTAL_ROWS - 2
    await expect(page.getByText(rowCountLabel(afterFirst))).toBeVisible({ timeout: 5_000 })

    // --- Second deletion: select and delete 2 more rows ---
    // Wait for the first loadData (fire-and-forget server refresh) to settle
    // so the grid shows consistent server data for the second selection.
    await waitForRefreshToSettle(page)

    // Verify count is still 8 after server refresh
    await expect(page.getByText(rowCountLabel(afterFirst))).toBeVisible({ timeout: 5_000 })

    // Select two more rows by checkbox. Keyboard Space can start editing in
    // editable grids, which is not what this deletion test is exercising.
    const refreshedRowCheckboxes = page.locator('.ag-row .ag-checkbox-input')
    await expect(refreshedRowCheckboxes).toHaveCount(afterFirst)
    await refreshedRowCheckboxes.nth(0).click({ force: true })
    await refreshedRowCheckboxes.nth(1).click({ force: true })

    // Right-click on a data cell to open context menu
    await page.locator('.ag-row').nth(0).locator('.ag-cell').nth(1).click({ button: 'right' })

    const secondDeleteBtn = page.locator('div.z-\\[9999\\] button', { hasText: 'Delete 2 rows' })
    await expect(secondDeleteBtn).toBeVisible({ timeout: 3_000 })
    await secondDeleteBtn.click()

    // Assert final count is original - 4 (both deletions applied)
    const expectedFinal = TOTAL_ROWS - 4
    await expect(page.getByText(rowCountLabel(expectedFinal))).toBeVisible({ timeout: 10_000 })

    // Assert grid shows the correct final number of rows
    await expect(page.locator('.ag-row')).toHaveCount(expectedFinal)
  })
})
