/**
 * E2E: Data export
 *
 * Tests that a user can trigger a CSV export of a table and
 * receive a download with the correct content.
 *
 * We test the export API directly here since triggering a browser
 * download is easier via request than through the UI download link.
 */
import { test, expect } from '../fixtures'

test('export table as CSV contains expected data', async ({ page, sessionId }) => {
  const res = await page.request.post(`/api/v1/sessions/${sessionId}/export`, {
    data: {
      database: 'e2e_test',
      table: 'products',
      format: 'csv',
    },
  })

  expect(res.status()).toBe(200)
  const contentType = res.headers()['content-type']
  expect(contentType).toContain('text/csv')

  const body = await res.text()
  // Should have a header row
  expect(body).toContain('title')
  expect(body).toContain('price')
  // Should contain all three seeded rows
  expect(body).toContain('Widget')
  expect(body).toContain('Gadget')
  expect(body).toContain('Doohickey')
})

test('export table as INSERT SQL contains correct statements', async ({ page, sessionId }) => {
  const res = await page.request.post(`/api/v1/sessions/${sessionId}/export`, {
    data: {
      database: 'e2e_test',
      table: 'products',
      format: 'insert',
    },
  })

  expect(res.status()).toBe(200)
  const body = await res.text()
  expect(body).toContain('INSERT INTO')
  expect(body).toContain('`products`')
  expect(body).toContain('Widget')
})

test('export content-disposition header has a filename', async ({ page, sessionId }) => {
  const res = await page.request.post(`/api/v1/sessions/${sessionId}/export`, {
    data: {
      database: 'e2e_test',
      table: 'products',
      format: 'csv',
    },
  })

  const disposition = res.headers()['content-disposition']
  expect(disposition).toContain('attachment')
  expect(disposition).toContain('.csv')
})
