import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
const page = await browser.newPage()
const logs = []
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
await page.goto('http://localhost:5199/dev-anim3.html')
await page.click('#go')
const frames = []
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(50)
  frames.push(await page.evaluate(() => {
    const el = document.querySelector('#box')
    const cs = getComputedStyle(el)
    return { op: cs.opacity, t: cs.transform }
  }))
}
console.log(JSON.stringify({ logs, frames }))
await browser.close()