/**
 * E2E: Query result horizontal scroll
 *
 * A wide text column must size to its content and overflow into the grid's
 * horizontal scrollbar instead of shrinking to an equal share of the viewport.
 */
import { test, expect, openSessionQueryTab, runShortcut } from '../fixtures'

test('scrolls a wide query result column horizontally', async ({ page, sessionId }) => {
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'DROP TABLE IF EXISTS e2e_test.wide_cells' },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `CREATE TABLE e2e_test.wide_cells (
              id INT PRIMARY KEY,
              payload TEXT
            ) ENGINE=InnoDB`,
    },
  })
  const payload = 'x'.repeat(3000)
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: `INSERT INTO e2e_test.wide_cells (id, payload) VALUES (1, '${payload}')` },
  })

  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('SELECT id, payload FROM e2e_test.wide_cells')
  await page.keyboard.press(runShortcut)

  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  const viewport = page.locator('.ag-body-horizontal-scroll-viewport')
  await expect.poll(() => viewport.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)

  const scrollLeft = await viewport.evaluate(el => {
    el.scrollLeft = 400
    return el.scrollLeft
  })
  expect(scrollLeft).toBeGreaterThan(0)

  await page.locator('.ag-row').first().locator('[col-id="payload"]').dblclick()
  const dialog = page.getByRole('dialog', { name: 'View cell' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('pre')).toHaveText(payload)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
})
