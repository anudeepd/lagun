import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { globSync } from 'node:fs'

describe('Motion bundle imports', () => {
  it('uses lightweight m components under LazyMotion strict', () => {
    const sourceRoot = resolve(process.cwd(), 'src')
    const offenders = globSync('**/*.{ts,tsx}', { cwd: sourceRoot })
      .filter(file => !file.includes('__tests__'))
      .filter(file => /import\s+\{[^}]*\bmotion\b[^}]*\}\s+from\s+['"]motion\/react['"]/.test(
        readFileSync(resolve(sourceRoot, file), 'utf8'),
      ))
    expect(offenders).toEqual([])
  })
})
