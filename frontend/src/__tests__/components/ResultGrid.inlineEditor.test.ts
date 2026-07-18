import { describe, expect, it, vi } from 'vitest'
import { startInlineCellEditing } from '../../components/editor/ResultGrid'

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
})
