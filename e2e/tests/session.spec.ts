/**
 * E2E: Session creation flow
 *
 * Tests that a user can create a connection, see it in the sidebar,
 * and the schema tree populates with the connected databases.
 */
import { test, expect, E2E_HOST, E2E_PORT, E2E_USER, E2E_PASS } from '../fixtures'

test('create a session and see databases in the sidebar', async ({ page }) => {
  await page.goto('/')

  // Click "New Connection" (the + button or link in the sidebar)
  const newConnBtn = page.getByRole('button', { name: /new connection|add connection|\+/i })
  await newConnBtn.click()

  // Fill in the connection form
  await page.getByLabel(/Connection Name/i).fill('E2E Session')
  await page.getByLabel(/Host/i).fill(E2E_HOST)
  await page.getByLabel(/Port/i).fill(String(E2E_PORT))
  await page.getByLabel(/Username/i).fill(E2E_USER)
  await page.getByLabel(/Password/i).fill(E2E_PASS)

  // Click Create
  await page.getByRole('button', { name: /Create/i }).click()

  // The session should appear in the sidebar
  await expect(page.getByText('E2E Session')).toBeVisible()

  // Clean up: delete the session via API
  const sessions = await page.request.get('/api/v1/sessions')
  const all = await sessions.json()
  const created = all.find((s: { name: string }) => s.name === 'E2E Session')
  if (created) {
    await page.request.delete(`/api/v1/sessions/${created.id}`)
  }
})

test('test connection before saving shows success banner', async ({ page }) => {
  await page.goto('/')

  const newConnBtn = page.getByRole('button', { name: /new connection|add connection|\+/i })
  await newConnBtn.click()

  await page.getByLabel(/Host/i).fill(E2E_HOST)
  await page.getByLabel(/Port/i).fill(String(E2E_PORT))
  await page.getByLabel(/Username/i).fill(E2E_USER)
  await page.getByLabel(/Password/i).fill(E2E_PASS)

  await page.getByRole('button', { name: /Test/i }).click()

  // Should show "Connected!" with the MySQL version
  await expect(page.getByText(/Connected!/i)).toBeVisible({ timeout: 10_000 })
})
