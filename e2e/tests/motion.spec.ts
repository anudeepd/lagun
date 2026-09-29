import { expect, test } from '@playwright/test'
import { createTestSession, deleteTestSession, seedDatabase } from '../fixtures'

let sessionId = ''

test.describe('motion system', () => {
  test.beforeEach(async ({ page }) => {
    // "New Query" only renders once a session is active, and the app store is
    // empty on an isolated run.
    sessionId = await createTestSession(page)
    // Seed before the first paint. The schema tree fetches a session's databases
    // when it activates, and a database created after that fetch never appears in
    // it — so a spec that seeds afterwards waits on a row the tree will not show.
    // This is the order the shared fixture uses for the same reason.
    await seedDatabase(page, sessionId)
    await page.goto('/')
    await expect(page.getByText('Query Log')).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    await deleteTestSession(page, sessionId)
  })

  test('keeps modal semantics immediate through animated exit', async ({ page }) => {
    await page.getByRole('button', { name: 'New Query', exact: true }).click()
    const tab = page.getByRole('tab', { name: /Query/ }).first()
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()

    const dialog = page.getByRole('dialog', { name: 'Rename Tab' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#lagun-overlays [aria-hidden="true"]')).toHaveCount(0, { timeout: 1000 })
  })

  test('plays a dialog exit animation instead of unmounting it', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Actions for E2E Test Session' })
    const row = trigger.locator('xpath=ancestor::div[2]')
    await row.hover()
    await trigger.click()
    await row.getByRole('menuitem', { name: 'Edit', exact: true }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const shell = await dialog.evaluateHandle(el => el.parentElement as HTMLElement)
    await expect.poll(() => shell.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBeGreaterThan(0.99)

    await page.keyboard.press('Escape')
    // A dialog whose component is unmounted is gone within one frame and never
    // reports a partial opacity; an animated one fades through intermediate
    // values before it detaches.
    await page.waitForFunction(
      el => el.isConnected && parseFloat(getComputedStyle(el).opacity) < 0.9,
      shell,
      { timeout: 2000 },
    )
    await expect.poll(() => shell.evaluate(el => el.isConnected)).toBe(false)
  })

  test('fades a Select listbox out instead of unmounting it in one frame', async ({ page }) => {
    // The schema view's Add Column dialog is the shortest path to a Select that
    // lives in a table tab. This file's beforeEach seeds e2e_test.products before
    // the page loads, so the tree already lists both.
    await page.locator('span.text-xs.truncate', { hasText: 'E2E Test Session' }).click()
    await page.getByText('e2e_test').click()
    await page.getByText('products').click()
    await page.getByRole('button', { name: 'Add Column' }).click()
    await expect(page.getByRole('dialog', { name: 'Add Column to products' })).toBeVisible()

    const trigger = page.getByRole('button', { name: 'Type' })
    const menuId = await trigger.getAttribute('aria-controls')
    expect(menuId).toBeTruthy()
    await trigger.click()

    // The listbox portals to document.body, so it is found by the id the
    // trigger advertises rather than by a role query scoped to the dialog.
    const listbox = page.locator(`[id="${menuId}"]`)
    await expect(listbox).toBeVisible()
    const handle = await listbox.evaluateHandle(el => el as HTMLElement)

    await trigger.click()
    // A listbox rendered from a plain `open ? … : null` is gone within one
    // frame and never reports a partial opacity; an animated one fades through
    // intermediate values before it detaches.
    await page.waitForFunction(
      el => el.isConnected && parseFloat(getComputedStyle(el).opacity) < 0.9,
      handle,
      { timeout: 2000 },
    )
    await expect.poll(() => handle.evaluate(el => el.isConnected)).toBe(false)
  })

  test('expands and reverses the Query Log without losing its endpoint', async ({ page }) => {
    const panel = page.getByText('Query Log').locator('xpath=../../..')
    await page.getByText('Query Log').click()
    await page.getByText('Query Log').click()
    await page.getByText('Query Log').click()
    await expect(panel).toHaveCSS('height', '208px')
    await page.getByText('Query Log').click()
    await expect(panel).toHaveCSS('height', '28px')
  })

  test('honors reduced motion while keeping state changes usable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'New Query', exact: true }).click()
    const tab = page.getByRole('tab', { name: /Query/ }).first()
    await expect(tab).toBeVisible()
    await tab.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Tab actions' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Tab actions' })).toHaveCount(0)
  })
})
