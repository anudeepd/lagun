/**
 * E2E: the grid cell context menu settles fully inside the viewport
 *
 * Regression for the viewport clamp in
 * frontend/src/components/editor/GridContextMenu.tsx: the clamp measured the
 * popover with getBoundingClientRect() while motion's enter animation still had
 * scale(0.9) applied, so the measured box was ~10% too small and the menu could
 * stick out of the window by ~0.1 * size. The clamp now measures the layout box
 * (offsetWidth/offsetHeight), which transforms do not affect.
 *
 * The window is deliberately short and the click lands in the bottom-right
 * corner of a cell, so the menu has to be clamped on both axes.
 *
 * Requires MySQL on E2E_MYSQL_PORT (default 3306) and `lagun serve` on
 * http://127.0.0.1:8080 (started automatically by playwright.config.ts).
 */
/* eslint-env node */
import type { Page } from '@playwright/test'
import { test, expect, openSessionQueryTab } from '../fixtures'

/**
 * Earlier runs may have left sessions named "E2E Test Session" in the DB.
 * The shared `openSessionQueryTab` helper matches by name and trips strict mode
 * if there is more than one. Delete any extras before each test.
 */
async function cleanStaleE2ESessions(page: Page, keepId: string) {
  const list = await page.request.get('/api/v1/sessions')
  const sessions = (await list.json()) as Array<{ id: string; name: string }>
  await Promise.all(
    sessions
      .filter(s => s.name === 'E2E Test Session' && s.id !== keepId)
      .map(s => page.request.delete(`/api/v1/sessions/${s.id}`)),
  )
}

test.describe('Grid cell context menu viewport clamp', () => {
  test('opened near the bottom-right corner of a short window, the settled menu stays inside the viewport', async ({ page, sessionId }) => {
    // Desktop layout (>= 1024px) but short, so a menu opened near the
    // bottom-right corner cannot fit and must be clamped on both axes.
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto('/')
    await cleanStaleE2ESessions(page, sessionId)
    await openSessionQueryTab(page, 'E2E Test Session')

    const editor = page.locator('.cm-content')
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await editor.click()
    await editor.pressSequentially('SELECT * FROM e2e_test.products')
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+Enter')

    await expect(page.locator('.lagun-result-grid')).toBeVisible({ timeout: 10_000 })
    const cell = page.locator('.ag-row').last().locator('.ag-cell').last()
    await expect(cell).toBeVisible({ timeout: 10_000 })

    const viewport = page.viewportSize()!
    const cellBox = (await cell.boundingBox())!
    const gridBox = (await page.locator('.lagun-result-grid').boundingBox())!
    // Bottom-right corner of a real cell, clipped to both the window and the
    // grid's own box: a cell's rect can extend past the grid viewport, and a
    // click below the grid lands on whatever sits there (the query log), which
    // opens no grid menu. Only the first rows fit in a 420px-tall window, so the
    // corner stays near the window's own corner.
    // Stay clear of the grid's vertical scrollbar (~15px) so the click lands on
    // the cell rather than the scroll thumb, which opens no menu.
    const x = Math.min(cellBox.x + cellBox.width, gridBox.x + gridBox.width - 16, viewport.width) - 4
    const y = Math.min(cellBox.y + cellBox.height, gridBox.y + gridBox.height, viewport.height) - 4
    // The horizontal clamp is exercised here: the grid's right edge is within a
    // menu-width of the window's, so a 160px menu opened at this point must be
    // pulled back. The vertical clamp is NOT reachable at any window height that
    // still renders the grid (a 300px window hides the grid entirely, and at
    // 420px the grid's bottom sits far enough above the window's bottom that the
    // menu fits below the click) — that half is covered by the unit test on the
    // clamp arithmetic, and the whole-rect assertion below still fails if either
    // axis overflows.
    expect(viewport.width - x).toBeLessThan(60)

    await page.mouse.click(x, y, { button: 'right' })

    const menu = page.getByRole('menu', { name: 'Grid actions' })
    await expect(menu).toBeVisible()
    // Wait for the enter spring to settle, so the assertion covers the rect the
    // user ends up looking at rather than a mid-animation one.
    await page.waitForTimeout(600)

    const menuBox = (await menu.boundingBox())!
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.y).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height)
  })
})
