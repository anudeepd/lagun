import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('root scroll boundary', () => {
  it('prevents pane scrolling from moving the document viewport', () => {
    expect(css).toContain('overscroll-behavior: none;')
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{\s*height: 100%;\s*overflow: hidden;/)
  })
})
