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
    expect(css).toContain('.lagun-result-grid .ag-cell-inline-editing .ag-number-field-input')
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-input-wrapper,[\s\S]*?\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input[\s\S]*?\{[^}]*border: 0;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input,[\s\S]*?\.lagun-result-grid \.ag-cell-inline-editing \.ag-number-field-input\s*\{[^}]*padding: 0;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-text-field-input,[\s\S]*?\.lagun-result-grid \.ag-cell-inline-editing \.ag-number-field-input\s*\{[^}]*outline: none;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing\s*\{[^}]*border: 0 !important;[^}]*box-shadow: none !important;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing\s*\{[^}]*background-color: #7c3a00 !important;[^}]*color: #fed7aa !important;/s)
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell-inline-editing \.ag-input-wrapper,[\s\S]*?\.lagun-result-grid \.ag-cell-inline-editing \.ag-number-field-input\s*\{[^}]*color: #fed7aa !important;/s)
  })

  it('keeps read and edit text on the same horizontal inset', () => {
    expect(css).toMatch(/\.lagun-result-grid \.ag-cell\s*\{[^}]*padding-left: 10px !important;[^}]*padding-right: 10px !important;/s)
  })

  it('shows no cell focus highlight on the row-selection checkbox column', () => {
    expect(css).toContain('.lagun-result-grid .ag-cell[col-id^="ag-Grid-ControlsColumn"].ag-cell-focus')
    expect(css).toContain('.lagun-result-grid .ag-cell[col-id^="ag-Grid-ControlsColumn"]:focus-within')
    expect(css).toMatch(/ag-Grid-ControlsColumn[\s\S]*?\{[^}]*border-color: transparent !important;/s)
    expect(css).toMatch(/ag-Grid-ControlsColumn[\s\S]*?\{[^}]*box-shadow: none !important;/s)
  })
})
