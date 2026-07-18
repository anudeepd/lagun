import { test } from '@playwright/test'

test('records representative motion frame timing', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New Query', exact: true }).click()

  const samples = await page.evaluate(async () => {
    const runs: Array<{ p95FrameMs: number; longTasks: number[] }> = []
    for (let run = 0; run < 5; run += 1) {
      const frames: number[] = []
      const longTasks: number[] = []
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration)
      })
      try { observer.observe({ type: 'longtask', buffered: false }) } catch { /* unsupported */ }
      let previous = performance.now()
      const end = previous + 2000
      await new Promise<void>(resolve => {
        const frame = (now: number) => {
          frames.push(now - previous)
          previous = now
          if (now >= end) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      observer.disconnect()
      frames.sort((a, b) => a - b)
      runs.push({ p95FrameMs: frames[Math.floor(frames.length * 0.95)] ?? 0, longTasks })
    }
    return runs
  })

  await testInfo.attach('motion-performance.json', {
    body: JSON.stringify(samples, null, 2),
    contentType: 'application/json',
  })
})
