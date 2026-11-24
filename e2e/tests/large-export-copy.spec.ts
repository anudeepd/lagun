/**
 * E2E: large row copies and custom limits.
 *
 * The legacy clipboard fallback must not put a multi-megabyte value into the
 * page just to copy it. On plain HTTP that layout work pushed the copy command
 * past the browser's user-activation window, so only small exports copied.
 */
import { test, expect, openProductsDataView } from '../fixtures'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test('secure-context copy uses the native Clipboard API', async ({ page, sessionId }) => {
  expect(sessionId).toBeTruthy()

  await openProductsDataView(page)
  const capabilities = await page.evaluate(() => ({
    secure: isSecureContext,
    clipboard: Boolean(navigator.clipboard),
  }))
  expect(capabilities).toEqual({ secure: true, clipboard: true })

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /Copied!/ })).toBeVisible()

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboardText).toContain('INSERT INTO `products`')
  expect(clipboardText).toContain("'Widget'")
})

test('custom limit above the presets copies all 10,000 table rows', async ({ page, sessionId }) => {
  test.setTimeout(60_000)

  const digits = Array.from({ length: 100 }, (_, index) => `SELECT ${index} AS n`).join(' UNION ALL ')
  const seeded = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `INSERT INTO e2e_test.products (title, price)
            SELECT CONCAT('Bulk ', a.n + b.n * 100 + 1), a.n + b.n * 100 + 1
            FROM (${digits}) a CROSS JOIN (${digits}) b`,
    },
  })
  expect((await seeded.json()).error).toBeNull()

  // Exercise the legacy path plain HTTP takes by removing the Clipboard API,
  // then restore an API the test can use to read back the copied text.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })

  await openProductsDataView(page)
  await page.getByRole('button', { name: 'Row limit' }).click()
  await page.getByRole('option', { name: 'Custom…' }).click()
  await page.getByRole('spinbutton', { name: 'Custom row limit' }).fill('10000')

  const loaded = page.waitForResponse(response =>
    response.request().method() === 'POST'
    && response.url().endsWith('/query')
    && response.request().postDataJSON()?.limit === 10_000
  )
  await page.getByRole('button', { name: 'Apply row limit' }).click()
  await loaded

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('10000 displayed rows')
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /Copied!/ })).toBeVisible()

  const clipboardText = await page.evaluate(async () => {
    delete navigator.clipboard
    return navigator.clipboard.readText()
  })
  // The fixture seeds three products before the 10,000 Bulk rows, so the
  // 10,000-row limit ends at Bulk 9997.
  expect(clipboardText).toContain("'Bulk 9997'")
  expect(clipboardText.match(/INSERT INTO/g)).toHaveLength(10_000)
})
