import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  headless: false,
})
const page = await browser.newPage()
await page.goto('http://localhost:5199/dev-anim4.html')
const frames = []
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(50)
  frames.push(await page.evaluate(() => {
    const el = document.querySelector('#box')
    const cs = getComputedStyle(el)
    return { op: cs.opacity, t: cs.transform }
  }))
}
console.log(JSON.stringify(frames))
await browser.close()