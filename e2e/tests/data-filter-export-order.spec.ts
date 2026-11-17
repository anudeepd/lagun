/**
 * E2E: Data-tab filter and export state
 *
 * Covers three regressions in the Data view:
 *
 *   1. Applying a WHERE filter on a scrolled grid kept the old scroll offset,
 *      so the matching rows above the viewport were missing and the grid showed
 *      only the tail of the result. Apply starts at the first matching row.
 *   2. Exporting selected rows used selection order because AG Grid stores
 *      selection in click order. Selected exports follow the sorted grid order.
 *   3. Closing the export dialog with Escape while the WHERE editor had focus
 *      dismissed the filter bar and reloaded every row. Escape belongs to the
 *      dialog until it closes.
 */
import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { dataGridRows, openProductsDataView, test, expect } from '../fixtures'

async function topVisibleTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.ag-body-viewport')?.getBoundingClientRect()
    if (!viewport) return null
    const rows = [...document.querySelectorAll('.ag-center-cols-container .ag-row')]
      .map(row => ({
        top: row.getBoundingClientRect().top,
        title: row.querySelector('[col-id="title"]')?.textContent ?? '',
      }))
      .filter(row => row.top >= viewport.top - 1 && row.top < viewport.bottom)
      .sort((a, b) => a.top - b.top)
    return rows[0]?.title ?? null
  })
}

async function applyFilter(page: Page, condition: string) {
  await page.locator('button[title="Toggle WHERE filter"]').click()
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.type(condition)
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
}

test('applying a filter starts a scrolled grid at the first matching row', async ({ page, sessionId }) => {
  const numbers = Array.from({ length: 100 }, (_, index) => `SELECT ${index + 1} AS n`).join(' UNION ALL ')
  const seeded = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `INSERT INTO e2e_test.products (title, price)
            SELECT CONCAT('Bulk ', n), n FROM (${numbers}) AS numbers`,
    },
  })
  expect((await seeded.json()).error).toBeNull()

  await openProductsDataView(page)
  await page.locator('.ag-body-viewport').evaluate(element => { element.scrollTop = 3000 })
  await expect.poll(() => topVisibleTitle(page)).not.toBe('Widget')

  await applyFilter(page, "title LIKE 'Bulk%'")

  await expect.poll(() => topVisibleTitle(page), { timeout: 10_000 }).toBe('Bulk 1')
})

test('selected-row export follows the sorted grid order', async ({ page, sessionId }) => {
  expect(sessionId).toBeTruthy()
  await openProductsDataView(page)

  const titleHeader = page.locator('.ag-header-cell[col-id="title"] .ag-header-cell-label')
  await titleHeader.click()
  await titleHeader.click()
  await expect(page.locator('.ag-header-cell[col-id="title"]')).toHaveAttribute('aria-sort', 'descending')

  const selection = (rowIndex: number) =>
    page.locator(`.ag-pinned-left-cols-container .ag-row[row-index="${rowIndex}"] input[type="checkbox"]`)
  // Select in an order that differs from the displayed order.
  await selection(2).check()
  await selection(0).check()
  await selection(1).check()

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Format' }).click()
  await page.getByRole('option', { name: 'CSV' }).click()

  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  const rows = fs.readFileSync(path, 'utf8')
    .split('\r\n')
    .slice(1)
    .filter(Boolean)
    .map(row => row.split(',')[0])

  expect(rows).toEqual(['Widget', 'Gadget', 'Doohickey'])
})

test('Escape closes the export dialog without clearing the applied filter', async ({ page, sessionId }) => {
  expect(sessionId).toBeTruthy()
  await openProductsDataView(page)

  await applyFilter(page, "title LIKE 'Widget%'")
  await expect(dataGridRows(page)).toHaveCount(1)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // The export chunk is lazy: focus can still sit in the WHERE editor while
  // the dialog mounts. Escape must belong to the dialog in that state.
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Escape')

  await expect(dialog).toBeHidden()
  await expect(page.locator('.cm-content')).toHaveText("title LIKE 'Widget%'")
  await expect(dataGridRows(page)).toHaveCount(1)
})
