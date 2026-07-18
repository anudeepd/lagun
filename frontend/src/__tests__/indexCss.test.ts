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

describe('data typography', () => {
  it('uses bundled Inter with data-friendly OpenType features', () => {
    expect(css).toContain("font-family: 'Inter Variable';")
    expect(css).toContain('--lagun-data-font: "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif;')
    expect(css).toMatch(/\.lagun-result-grid,\s*\.lagun-data-text\s*\{[^}]*font-variant-numeric: tabular-nums;/s)
    expect(css).toMatch(/font-feature-settings: "ss02" 1, "zero" 1;/)
  })
})

describe('inline cell editor', () => {
  it('uses a single cell focus ring without a nested input border', () => {
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-input-wrapper,\s*\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input\s*\{[^}]*border: 0;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input\s*\{[^}]*padding: 0;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input\s*\{[^}]*outline: none;/s)
  })

  it('keeps read and edit text on the same horizontal inset', () => {
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell\s*\{[^}]*padding-left: 10px !important;[^}]*padding-right: 10px !important;/s)
  })
})
