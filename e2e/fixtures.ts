/**
 * Shared fixtures and helpers for Playwright e2e tests.
 *
 * Assumes the following are already running before tests start:
 *   - MySQL on E2E_MYSQL_PORT (default 3307) with user/pass/db = test/test/test
 *   - lagun serve on http://127.0.0.1:8080
 *
 * Set environment variables to override:
 *   E2E_MYSQL_HOST, E2E_MYSQL_PORT, E2E_MYSQL_USER, E2E_MYSQL_PASS
 */
import { test as base, expect, Page } from '@playwright/test'

export const E2E_HOST = process.env.E2E_MYSQL_HOST ?? '127.0.0.1'
export const E2E_PORT = parseInt(process.env.E2E_MYSQL_PORT ?? '3306')
export const E2E_USER = process.env.E2E_MYSQL_USER ?? 'dev'
export const E2E_PASS = process.env.E2E_MYSQL_PASS ?? 'dev'

/** Create a session via the API and return its ID. */
export async function createTestSession(page: Page): Promise<string> {
  const res = await page.request.post('/api/v1/sessions', {
    data: {
      name: 'E2E Test Session',
      host: E2E_HOST,
      port: E2E_PORT,
      username: E2E_USER,
      password: E2E_PASS,
    },
  })
  const session = await res.json()
  return session.id
}

/** Delete a session via the API. */
export async function deleteTestSession(page: Page, sessionId: string) {
  await page.request.delete(`/api/v1/sessions/${sessionId}`)
}

/** Seed the e2e_test database with a `products` table. */
export async function seedDatabase(page: Page, sessionId: string) {
  // Create the database via a raw query
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'CREATE DATABASE IF NOT EXISTS `e2e_test`' },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `CREATE TABLE IF NOT EXISTS e2e_test.products (
              id INT AUTO_INCREMENT PRIMARY KEY,
              title VARCHAR(200) NOT NULL,
              price DECIMAL(10,2)
            ) ENGINE=InnoDB`,
    },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `INSERT INTO e2e_test.products (title, price)
            VALUES ('Widget', 9.99), ('Gadget', 19.99), ('Doohickey', 4.99)`,
    },
  })
}

/** Drop the e2e_test database. */
export async function teardownDatabase(page: Page, sessionId: string) {
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'DROP DATABASE IF EXISTS `e2e_test`' },
  })
}

/**
 * Click a session in the sidebar and open a new query tab via the context menu.
 * Needed because the editor (.cm-content) only exists inside an open query tab.
 */
export async function openSessionQueryTab(page: Page, sessionName: string) {
  const sessionSpan = page.locator('span.text-xs.truncate', { hasText: sessionName })
  await sessionSpan.click() // activate the session
  const sessionRow = sessionSpan.locator('xpath=..')
  await sessionRow.hover()  // reveal the context menu button
  await sessionRow.locator('div.relative button').click()
  await page.getByRole('button', { name: 'New Query', exact: true }).click()
}

/** Extended test with a fully set-up session + seeded DB. */
export const test = base.extend<{
  sessionId: string
}>({
  sessionId: async ({ page }, use) => {
    const id = await createTestSession(page)
    await seedDatabase(page, id)
    await use(id)
    await teardownDatabase(page, id)
    await deleteTestSession(page, id)
  },
})

export { expect }
