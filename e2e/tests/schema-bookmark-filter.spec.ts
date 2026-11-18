/**
 * E2E: Bookmark filter star
 *
 * Activating the bookmark filter must not leave the header star tilted. The
 * per-table stars pop and settle; the filter star used to stay at 8 degrees.
 */
import { test, expect } from '../fixtures'

test('settles the bookmark filter star after it turns on', async ({ page, sessionId }) => {
  await page.goto('/')
  await page.getByText('E2E Test Session', { exact: true }).click()

  await page.getByRole('button', { name: 'Show bookmarks only' }).click()

  const activeStar = page.getByRole('button', { name: 'Show all tables' })
  await expect(activeStar).toBeVisible()

  // Let the press and settle animation finish before reading the transform.
  await page.waitForTimeout(500)

  await expect.poll(async () => activeStar.evaluate(el => {
    const transform = getComputedStyle(el).transform
    return transform === 'none' ? 0 : Math.abs(new DOMMatrix(transform).b)
  })).toBeLessThan(0.01)
})
