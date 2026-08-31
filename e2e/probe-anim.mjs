import { chromium } from 'playwright'

const url = process.argv[2] || 'http://localhost:5199/dev-anim.html'
const browser = await chromium.launch({ executablePath: '/home/puppyseal/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
const page = await browser.newPage()
await page.goto(url)
await page.click('#open')
await page.waitForSelector('.fixed.inset-0.z-modal')
await page.waitForTimeout(600)
const before = await page.evaluate(() => {
  const el = document.querySelector('.relative.flex.max-h-\\[90vh\\]')
  const cs = getComputedStyle(el)
  return { op: cs.opacity, t: cs.transform }
})
await page.keyboard.press('Escape')
const frames = []
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(30)
  const s = await page.evaluate(() => {
    const wrap = document.querySelector('.fixed.inset-0.z-modal')
    const el = document.querySelector('.relative.flex.max-h-\\[90vh\\]')
    const fmt = n => { if (!n) return null; const cs = getComputedStyle(n); return { op: cs.opacity, t: cs.transform } }
    return { wrap: fmt(wrap), dialog: fmt(el) }
  })
  frames.push(s)
  if (!s.wrap && !s.dialog) break
}
await browser.close()
console.log('URL', url)
console.log('BEFORE', JSON.stringify(before))
console.log('FRAMES', JSON.stringify(frames))