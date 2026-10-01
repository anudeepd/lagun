/**
 * E2E: Table-tab toolbar (Data view)
 *
 * Covers the two things 0.1.99's chrome pass got wrong in the table toolbar:
 *
 *   1. `db.table` is the table's identity, not chrome. The toolbar is
 *      `select-none` so a press-drag starting in a gap cannot paint the buttons,
 *      but the caption itself must stay selectable — double-clicking it is how
 *      the name gets copied.
 *   2. The WHERE filter's CodeMirror must not draw an outline of its own.
 *      `@codemirror/view`'s base theme rings a focused editor with
 *      `1px dotted #212121`; the container already shows focus as a 2px brand
 *      ring plus a brand border, and the dark dots landed exactly on that border
 *      as a perforated edge.
 *
 * Requires MySQL on E2E_MYSQL_PORT (default 3306) and `lagun serve` on
 * http://127.0.0.1:8080 (started automatically by playwright.config.ts).
 * See e2e/README.md for setup instructions.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures'

/** Activate the seeded session, open `e2e_test.products` and switch to Data. */
async function openProductsDataView(page: Page) {
  await page.goto('/')

  // Activate the session to show the schema tree
  await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()

  // Expand the e2e_test database node, then open the products table
  await page.getByText('e2e_test').click()
  await page.getByText('products').click()

  // Switch to Data view and wait for rows
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })
}

test('double-clicking the db.table caption selects the name', async ({ page, sessionId }) => {
  expect(sessionId).toBeTruthy()
  await openProductsDataView(page)

  const caption = page.locator('span[title="e2e_test.products"]')
  await expect(caption).toBeVisible()

  // Land on the first word: the caption is "e2e_test.products".
  await caption.dblclick({ position: { x: 12, y: 8 } })
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected).toBe('e2e_test')

  // The rest of the toolbar stays unselectable: a double-click next to the
  // caption must not add anything to the selection.
  await page.mouse.dblclick(400, (await caption.boundingBox())!.y + 8)
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('e2e_test')
})

test('the WHERE filter editor draws no outline of its own', async ({ page, sessionId }) => {
  expect(sessionId).toBeTruthy()
  await openProductsDataView(page)

  await page.locator('button[title="Toggle WHERE filter"]').click()
  const editor = page.locator('.cm-editor')
  await expect(editor).toBeVisible()
  await page.locator('.cm-content').click()

  // Focused: the container's :focus-within ring is the indicator, the editor
  // itself contributes nothing (a dotted 1px outline before the fix).
  const state = await editor.evaluate(el => {
    const wrapper = el.parentElement?.parentElement
    return {
      focused: el.classList.contains('cm-focused'),
      outlineStyle: getComputedStyle(el).outlineStyle,
      wrapperRing: wrapper ? getComputedStyle(wrapper).boxShadow : 'none',
    }
  })
  expect(state.focused).toBe(true)
  expect(state.outlineStyle).toBe('none')
  expect(state.wrapperRing).not.toBe('none')
})
