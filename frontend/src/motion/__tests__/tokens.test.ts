import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { motionDuration, motionEase } from '../tokens'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('motion tokens', () => {
  it('keeps shared CSS durations aligned with TypeScript values', () => {
    expect(css).toContain(`--motion-duration-micro: ${motionDuration.micro * 1000}ms`)
    expect(css).toContain(`--motion-duration-surface: ${motionDuration.surface * 1000}ms`)
    expect(css).toContain(`--motion-duration-spatial: ${motionDuration.spatial * 1000}ms`)
  })

  it('keeps shared easing curves aligned', () => {
    expect(css).toContain(`--motion-ease-move: cubic-bezier(${motionEase.move.join(', ')})`)
    expect(css).toContain(`--motion-ease-exit: cubic-bezier(${motionEase.exit.join(', ')})`)
  })
})
