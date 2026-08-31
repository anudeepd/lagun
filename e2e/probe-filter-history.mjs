import { chromium } from 'playwright'

// Demonstrates the WHERE filter history dropdown:
// apply three filters, then open the history picker and screenshot it.
const browser = await chromium.launch({
  executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
await page.goto('http://localhost:5173')
await page.waitForSelector('#root > *', { timeout: 20000 })

// Idempotent: remove leftovers from previous runs, then create a fresh session.
const existing = await (await page.request.get('http://localhost:5173/api/v1/sessions')).json()
for (const s of existing.filter(s => s.name === 'HistDemo')) {
  await page.request.delete(`http://localhost:5173/api/v1/sessions/${s.id}`)
}
const sessionRes = await page.request.post('http://localhost:5173/api/v1/sessions', {
  data: { name: 'HistDemo', host: '127.0.0.1', port: 3308, username: 'root', password: 'demo' },
})
const session = await sessionRes.json()
// Created outside the UI, so reload for the sidebar store to pick it up.
await page.reload()
await page.waitForSelector('#root > *', { timeout: 20000 })
await page.waitForTimeout(500)

// Open the session in the sidebar.
await page.getByText('HistDemo', { exact: true }).click()
await page.waitForTimeout(1000)
// Expand lagun_demo and open the products table data tab.
await page.locator('button[title="lagun_demo"]').click()
await page.locator('button[title="lagun_demo.products"]').waitFor({ timeout: 10000 })
await page.locator('button[title="lagun_demo.products"]').click()
await page.waitForTimeout(1500)
// Switch from Schema to the Data view.
await page.getByRole('button', { name: 'Data', exact: true }).click()
await page.waitForTimeout(1500)

// Open the WHERE filter bar.
await page.locator('button[title="Toggle WHERE filter"]').click()
await page.waitForTimeout(400)
const applyFilter = async (text) => {
  await page.locator('.cm-content').last().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(text)
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(700)
}
await applyFilter("price > 5")
await applyFilter("name LIKE '%get%'")
await applyFilter('price < 20')

// Open the history dropdown and screenshot with it visible.
await page.locator('button[aria-label="Recent filters"]').click()
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/filter-history-open.png' })

// Pick the second entry and screenshot the applied state.
await page.locator('[role="menu"] [role="menuitem"]').nth(1).click()
await page.waitForTimeout(900)
await page.screenshot({ path: '/tmp/filter-history-applied.png' })

// Cleanup session.
await page.request.delete(`http://localhost:5173/api/v1/sessions/${session.id}`)
await browser.close()
console.log('done')
