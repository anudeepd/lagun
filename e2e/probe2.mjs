import { chromium } from 'playwright'

const url = 'http://localhost:5199/dev-anim2.html'
const browser = await chromium.launch({ executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
const page = await browser.newPage()
const logs = []
page.on('console', m => logs.push(m.type() + ': ' + m.text()))
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
await page.goto(url)
await page.click('#open')
await page.waitForTimeout(800)
const html = await page.evaluate(() => document.body.innerHTML.slice(0, 300))
console.log(JSON.stringify({ logs, html }))
await browser.close()