/**
 * E2E: the active-cell ring belongs to the focused grid.
 *
 * The ring is a lagun `!important` inset shadow (an inset shadow so Firefox
 * snaps all four edges as one shape at fractional display scaling). Unlike AG
 * Grid's own 1px border, which is keyed on `:focus-within`, the shadow had no
 * focus condition: a cell clicked once kept ringing after the user clicked
 * outside the grid. These assertions pin the ring to the grid's focus, and
 * keep it while the cell context menu is open — its items act on the cell that
 * was right-clicked, which has handed DOM focus to the menu.
 */
import { test, expect } from '../fixtures'

test('clears the active-cell ring when focus leaves the grid', async ({ page, sessionId }) => {
  void sessionId
  await page.goto('/')

  // Activate the seeded session and open the products table in Data view.
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  await page.locator('.ag-row').first().waitFor({ state: 'visible', timeout: 10_000 })

  const cell = page.locator('.ag-row').first().locator('[col-id="title"]')
  await cell.click()
  await expect(cell).toHaveClass(/ag-cell-focus/)
  await expect.poll(() => cell.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none')

  // Clicking outside must clear the ring. AG keeps its own `ag-cell-focus`
  // marker on the cell, so the class alone cannot be the assertion.
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
  await expect(cell).toHaveClass(/ag-cell-focus/)
  await expect.poll(() => cell.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none')

  // The context menu acts on the right-clicked cell: the ring stays while it
  // is open, even though focus sits on the menu.
  await cell.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Grid actions' })).toBeVisible()
  await expect.poll(() => cell.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none')
})
