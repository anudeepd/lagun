import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
const page = await browser.newPage()
const logs = []
page.on('console', m => logs.push(m.type() + ': ' + m.text()))
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
await page.goto('http://localhost:5199/dev-anim4.html')
await page.waitForTimeout(1000)
console.log(JSON.stringify({ logs }, null, 1))
await browser.close()