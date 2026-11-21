/**
 * E2E: schema sidebar chrome
 *
 * Covers three defects the schema sidebar showed together. The databases
 * bookmark star used a spring for its three keyframes, so it never moved while
 * the table stars popped. Its tooltip was absolutely positioned inside the
 * schema pane's `overflow-hidden` box, so the connection list painted over it.
 * The bookmark filter also rendered tables in whatever order the API returned.
 *
 * Every API route is mocked, so this spec needs no database.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION = {
  id: 's1',
  name: 'Sidebar Test',
  host: 'localhost',
  port: 3306,
  username: 'root',
  default_db: null,
  query_limit: 100,
  ssl_enabled: false,
  selected_databases: [],
  is_default: true,
  managed: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

const unsortedTables = ['zebra', 'alpha', 'mango', 'beta'].map(name => ({
  name,
  table_type: 'BASE TABLE',
  engine: 'InnoDB',
  row_count: 1,
  data_length: 100,
  comment: '',
}))

async function mockSchemaApi(page: Page) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/config/server')) {
      return route.fulfill({ json: { ldap_enabled: false, ldap_idle_timeout: 0, is_admin: false } })
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: [SESSION] })
    if (/\/sessions\/[^/]+\/databases$/.test(path)) return route.fulfill({ json: ['app_db'] })
    if (/\/sessions\/[^/]+\/databases\/app_db\/tables$/.test(path)) {
      return route.fulfill({ json: unsortedTables })
    }
    if (/\/sessions\/[^/]+\/tables$/.test(path)) {
      return route.fulfill({ json: { app_db: unsortedTables } })
    }
    if (path.includes('/presence')) return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: {} })
  })
}

/** No ancestor may clip a tooltip: a clipping pane is how it hid before. */
function hasNoClippingAncestor(el: Element) {
  let node = el.parentElement
  while (node && node !== document.body) {
    const { overflow, overflowX, overflowY } = getComputedStyle(node)
    if ([overflow, overflowX, overflowY].some(value => value !== 'visible')) return false
    node = node.parentElement
  }
  return node === document.body
}

async function expectFullyVisible(page: Page, tip: Locator) {
  const box = await tip.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
}

test('lists bookmarked tables in name order', async ({ page }) => {
  await mockSchemaApi(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      'lagun-bookmarks-s1',
      JSON.stringify(['app_db/zebra', 'app_db/mango', 'app_db/beta', 'app_db/alpha']),
    )
  })
  await page.goto('/')

  await page.getByRole('button', { name: 'Show bookmarks only' }).click()

  await expect.poll(() =>
    page.locator('[title^="app_db."]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('title')),
    ),
  ).toEqual(['app_db.alpha', 'app_db.beta', 'app_db.mango', 'app_db.zebra'])
})

test('keeps the databases tooltips outside the clipping pane', async ({ page }) => {
  await mockSchemaApi(page)
  await page.goto('/')

  const star = page.getByRole('button', { name: 'Show bookmarks only' })
  await star.hover()
  const starTip = page.getByRole('tooltip', { name: 'Show bookmarks only' })
  await expect(starTip).toBeVisible()
  expect(await starTip.evaluate(hasNoClippingAncestor)).toBe(true)

  const refresh = page.getByRole('button', { name: 'Refresh databases' })
  await refresh.hover()
  const refreshTip = page.getByRole('tooltip', { name: 'Refresh databases' })
  await expect(refreshTip).toBeVisible()
  expect(await refreshTip.evaluate(hasNoClippingAncestor)).toBe(true)
})

test('keeps the session actions tooltip visible at the sidebar edge', async ({ page }) => {
  await mockSchemaApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Actions for Sidebar Test' }).hover()
  const tip = page.getByRole('tooltip', { name: 'Actions for Sidebar Test' })
  await expect(tip).toBeVisible()
  expect(await tip.evaluate(hasNoClippingAncestor)).toBe(true)
  await expectFullyVisible(page, tip)
})

test('keeps the query log tooltips inside the viewport', async ({ page }) => {
  await mockSchemaApi(page)
  await page.addInitScript(() => {
    localStorage.setItem('lagun-query-log', JSON.stringify({
      state: {
        entries: [{
          id: 'log-1',
          timestamp: new Date().toISOString(),
          sql: 'SELECT 1',
          sessionId: 's1',
          rowCount: 1,
          execTimeMs: 1,
        }],
      },
      version: 3,
    }))
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Query Log/ }).click()

  for (const label of ['Copy SQL', 'Open in new query tab']) {
    await page.getByRole('button', { name: label, exact: true }).hover()
    const tip = page.getByRole('tooltip', { name: label })
    await expect(tip).toBeVisible()
    expect(await tip.evaluate(hasNoClippingAncestor)).toBe(true)
    await expectFullyVisible(page, tip)
  }
})

test('gives the connection header icons tooltips', async ({ page }) => {
  await mockSchemaApi(page)
  await page.goto('/')

  for (const label of ['Import connections', 'Export connections', 'New connection']) {
    await page.getByRole('button', { name: label }).hover()
    await expect(page.getByRole('tooltip', { name: label })).toBeVisible()
  }
})

test('pops the databases bookmark star like the table stars', async ({ page }) => {
  await mockSchemaApi(page)
  await page.goto('/')

  const star = page.getByRole('button', { name: 'Show bookmarks only' })
  const handle = await star.elementHandle()
  await star.click()

  // The pre-fix button stayed at transform: none for the whole animation.
  const peakRotation = await handle!.evaluate(async el => {
    let peak = 0
    for (let frame = 0; frame < 20; frame += 1) {
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => resolve())
      await promise
      const transform = getComputedStyle(el).transform
      if (transform !== 'none') peak = Math.max(peak, Math.abs(new DOMMatrix(transform).b))
    }
    return peak
  })

  expect(peakRotation).toBeGreaterThan(0.1)
})
