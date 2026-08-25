import { describe, expect, it, vi } from 'vitest'
import { focusTextareaAtEnd, formatResultGridCellValue, placeInlineEditorCaretAtEnd, startInlineCellEditing } from '../../components/editor/ResultGrid'

describe('ResultGrid inline editor', () => {
  it('uses AG Grid\'s caret-preserving edit mode instead of a browser-timed correction', () => {
    const startEditingCell = vi.fn()

    startInlineCellEditing({ startEditingCell }, 3, 'email')

    expect(startEditingCell).toHaveBeenCalledWith({
      rowIndex: 3,
      colKey: 'email',
      key: 'F2',
    })
  })

  it('renders NULL distinctly while preserving an empty string', () => {
    expect(formatResultGridCellValue(null)).toBe('NULL')
    expect(formatResultGridCellValue('')).toBe('')
  })

  it('focuses the popup textarea with its caret at the value end', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'existing value'
    document.body.append(textarea)

    focusTextareaAtEnd(textarea)

    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(textarea.selectionEnd).toBe(textarea.value.length)
    textarea.remove()
  })

  it('places the inline editor caret at the end once editing starts', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="ag-cell-inline-editing"><input value="Mechanical Keyboard"></div>'
    document.body.append(root)

    placeInlineEditorCaretAtEnd(root)

    const input = root.querySelector('input')!
    expect(input.selectionStart).toBe(input.value.length)
    expect(input.selectionEnd).toBe(input.value.length)
    root.remove()
  })
})
