/**
 * E2E: Query execution flow
 *
 * Tests that a user can select a database, type a query in the editor,
 * run it, and see results in the grid.
 */
import { test, expect, openSessionQueryTab } from '../fixtures'

test('run a SELECT query and see results in the grid', async ({ page, sessionId }) => {
  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  // Type a query in the CodeMirror editor
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('SELECT * FROM e2e_test.products')

  // Run the query
  await page.keyboard.press('Control+Enter')

  // Wait for the ag-grid to render rows
  await expect(page.locator('.ag-row').first()).toBeVisible({ timeout: 10_000 })

  // Should have 3 rows (Widget, Gadget, Doohickey)
  const rows = page.locator('.ag-row')
  await expect(rows).toHaveCount(3)

  // Column headers should include 'title' and 'price'
  await expect(page.locator('.ag-header-cell-text', { hasText: 'title' })).toBeVisible()
  await expect(page.locator('.ag-header-cell-text', { hasText: 'price' })).toBeVisible()
})

test('run a COUNT query and see scalar result', async ({ page, sessionId }) => {
  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially('SELECT COUNT(*) FROM e2e_test.products')
  await page.keyboard.press('Control+Enter')

  await expect(page.locator('.ag-cell', { hasText: '3' })).toBeVisible({ timeout: 10_000 })
})

test('bulk execution commits a large insert script', async ({ page, sessionId }) => {
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'DROP TABLE IF EXISTS e2e_test.bulk_success' },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `CREATE TABLE IF NOT EXISTS e2e_test.bulk_success (
              id INT PRIMARY KEY,
              name VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB`,
    },
  })

  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const sql = Array.from({ length: 25 }, (_, i) =>
    `INSERT INTO e2e_test.bulk_success (id, name) VALUES (${i + 1}, 'row ${i + 1}')`
  ).join(';\n')

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially(sql)
  await page.keyboard.press('Control+Enter')

  await expect(page.getByText('Large write script')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Committed')).toBeVisible({ timeout: 10_000 })

  const count = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'SELECT COUNT(*) FROM e2e_test.bulk_success' },
  })
  expect((await count.json()).rows[0][0]).toBe(25)
})

test('bulk execution rolls back a failed large insert script', async ({ page, sessionId }) => {
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'DROP TABLE IF EXISTS e2e_test.bulk_rollback' },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `CREATE TABLE IF NOT EXISTS e2e_test.bulk_rollback (
              id INT PRIMARY KEY,
              name VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB`,
    },
  })

  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const statements = Array.from({ length: 25 }, (_, i) =>
    `INSERT INTO e2e_test.bulk_rollback (id, name) VALUES (${i + 1}, 'row ${i + 1}')`
  )
  statements[12] = "INSERT INTO e2e_test.bulk_rollback (id, name) VALUES (1, 'duplicate')"

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially(statements.join(';\n'))
  await page.keyboard.press('Control+Enter')

  await expect(page.getByText('Rolled back', { exact: true })).toBeVisible({ timeout: 10_000 })

  const count = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'SELECT COUNT(*) FROM e2e_test.bulk_rollback' },
  })
  expect((await count.json()).rows[0][0]).toBe(0)
})

test('bulk execution rejects unsupported large mixed scripts without running', async ({ page, sessionId }) => {
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'DROP TABLE IF EXISTS e2e_test.bulk_reject' },
  })
  await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: {
      sql: `CREATE TABLE IF NOT EXISTS e2e_test.bulk_reject (
              id INT PRIMARY KEY,
              name VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB`,
    },
  })

  await page.goto('/')
  await openSessionQueryTab(page, 'E2E Test Session')

  const writes = Array.from({ length: 25 }, (_, i) =>
    `INSERT INTO e2e_test.bulk_reject (id, name) VALUES (${i + 1}, 'row ${i + 1}')`
  )
  const sql = `${writes.join(';\n')};\nSELECT COUNT(*) FROM e2e_test.bulk_reject`

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.pressSequentially(sql)
  await page.keyboard.press('Control+Enter')

  await expect(page.getByText(/Statement 26 starts with SELECT/)).toBeVisible({ timeout: 10_000 })

  const count = await page.request.post(`/api/v1/sessions/${sessionId}/query`, {
    data: { sql: 'SELECT COUNT(*) FROM e2e_test.bulk_reject' },
  })
  expect((await count.json()).rows[0][0]).toBe(0)
})
