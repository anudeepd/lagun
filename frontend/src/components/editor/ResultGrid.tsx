/* eslint-disable react-refresh/only-export-components */
import { useMemo, useCallback, useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { themeQuartz } from 'ag-grid-community'
import { Copy, Braces, Slash, Clock, Trash2, CopyPlus, PencilLine } from 'lucide-react'
import type { CellClassParams, CellClickedEvent, CellContextMenuEvent, CellDoubleClickedEvent, CellFocusedEvent, CellValueChangedEvent, RowClickedEvent, GridApi, ColumnHeaderClickedEvent } from 'ag-grid-community'
import Modal from '../ui/Modal'
import Button from '../ui/Button'

export interface ResultGridHandle {
  isAnyFilterPresent: () => boolean
  getFilteredData: () => { columns: string[], rows: unknown[][] }
  stopEditing: () => void
  deselectAll: () => void
  clearSort: () => void
  isAnySortPresent: () => boolean
}

export interface InsertDraftAnchor {
  afterRowId: string
}
export type DuplicateRowMode = 'withKeys' | 'withoutKeys'
import GridContextMenu, { type ContextMenuItem } from './GridContextMenu'
import type { QueryResult, ColumnInfo } from '../../types'
import { clipboardWrite } from '../../utils/clipboard'

const darkTheme = themeQuartz.withParams({
  backgroundColor: '#0f172a',
  foregroundColor: '#cbd5e1',
  headerBackgroundColor: '#1e293b',
  headerTextColor: '#94a3b8',
  borderColor: '#1e293b',
  rowHoverColor: '#1e293b',
  selectedRowBackgroundColor: '#1e3a5f',
  oddRowBackgroundColor: '#0f172a',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  cellTextColor: '#cbd5e1',
  headerFontSize: 12,
  headerFontWeight: 600,
})

const DATE_TYPES = new Set(['datetime', 'timestamp', 'date', 'time'])
const COLUMN_WIDTH_SAMPLE_SIZE = 40

function displayLength(value: unknown): number {
  if (value == null) return 4
  return String(value).length
}

function localNow(dataType: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  if (dataType === 'date') return date
  if (dataType === 'time') return time
  return `${date} ${time}`
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
}

function valueNeedsLargeEditor(value: unknown, eventTarget: EventTarget | null): boolean {
  if (value != null && /[\n\r]/.test(String(value))) return true

  if (eventTarget instanceof HTMLElement) {
    const cell = eventTarget.closest<HTMLElement>('.ag-cell')
    const content = cell?.querySelector<HTMLElement>('.ag-cell-value') ?? cell
    if (content && content.clientWidth > 0) {
      return content.scrollWidth > content.clientWidth + 1
    }
  }

  return value != null && String(value).length > 80
}

interface MenuState {
  x: number
  y: number
  columnName: string
  cellValue: unknown
  rowData: Record<string, unknown>
  selectedRows: Record<string, unknown>[]
}

interface ActiveCell {
  rowIndex: number
  columnName: string
  value: unknown
  data: Record<string, unknown>
}

interface CellEditorState {
  columnName: string
  oldValue: unknown
  data: Record<string, unknown>
  value: string
  wasNull: boolean
}

interface Props {
  result: QueryResult
  onCellEdit?: (params: {
    column: string
    newValue: unknown
    oldValue: unknown
    data: Record<string, unknown>
  }) => void
  primaryKeyColumns?: string[]
  editable?: boolean
  selectable?: boolean
  onSelectionChange?: (rows: Record<string, unknown>[]) => void
  columns?: ColumnInfo[]
  onDeleteRows?: (rows: Record<string, unknown>[]) => void
  onDuplicateRow?: (row: Record<string, unknown>, mode: DuplicateRowMode) => void
  hiddenColumns?: Set<string>
  pendingChanges?: Map<string, { original: Record<string, unknown>; changes: Record<string, unknown> }>
  insertDrafts?: Map<string, Record<string, unknown>>
  insertDraftAnchors?: Map<string, InsertDraftAnchor>
  includeRowIndexInId?: boolean
  onSortActiveChange?: (active: boolean) => void
}

export const buildResultGridRowId = (
  row: Record<string, unknown>,
  rowIdx: number,
  keyColumns: string[],
  includeRowIndexInId = keyColumns.length === 0,
): string => {
  const keyValues = keyColumns.map(col => String(row[col] ?? '')).join('\x00')
  if (includeRowIndexInId) return `${keyValues}\x00${rowIdx}`
  return keyValues || String(rowIdx)
}

export const buildResultGridRowData = ({
  result,
  primaryKeyColumns = [],
  pendingChanges,
  insertDrafts,
  insertDraftAnchors,
  includeRowIndexInId,
}: {
  result: QueryResult
  primaryKeyColumns?: string[]
  pendingChanges?: Map<string, { original: Record<string, unknown>; changes: Record<string, unknown> }>
  insertDrafts?: Map<string, Record<string, unknown>>
  insertDraftAnchors?: Map<string, InsertDraftAnchor>
  includeRowIndexInId?: boolean
}): Record<string, unknown>[] => {
  const rows = result.rows.map((row, rowIdx) => {
    const obj: Record<string, unknown> = {}
    result.columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    obj.__ag_rowIndex = rowIdx
    const keyCols = primaryKeyColumns.length > 0 ? primaryKeyColumns : result.columns
    obj.__ag_rowId = buildResultGridRowId(obj, rowIdx, keyCols, includeRowIndexInId ?? primaryKeyColumns.length === 0)
    const pending = pendingChanges?.get(obj.__ag_rowId as string)
    if (pending) Object.assign(obj, pending.changes)
    return obj
  })

  if (!insertDrafts?.size) return rows

  const draftsByAnchor = new Map<string, Record<string, unknown>[]>()
  const unanchoredDrafts: Record<string, unknown>[] = []
  for (const [rowId, values] of insertDrafts) {
    const obj: Record<string, unknown> = {}
    result.columns.forEach(col => {
      obj[col] = values[col] ?? null
    })
    obj.__ag_rowId = rowId
    obj.__lagun_insertDraft = true
    const anchor = insertDraftAnchors?.get(rowId)?.afterRowId
    if (anchor) {
      const drafts = draftsByAnchor.get(anchor) ?? []
      drafts.push(obj)
      draftsByAnchor.set(anchor, drafts)
    } else {
      unanchoredDrafts.push(obj)
    }
  }

  const orderedRows: Record<string, unknown>[] = []
  const insertedDraftIds = new Set<string>()
  for (const row of rows) {
    orderedRows.push(row)
    const drafts = draftsByAnchor.get(row.__ag_rowId as string)
    if (!drafts) continue
    orderedRows.push(...drafts)
    drafts.forEach(draft => insertedDraftIds.add(draft.__ag_rowId as string))
  }

  for (const drafts of draftsByAnchor.values()) {
    for (const draft of drafts) {
      if (!insertedDraftIds.has(draft.__ag_rowId as string)) {
        unanchoredDrafts.push(draft)
      }
    }
  }

  return [...orderedRows, ...unanchoredDrafts]
}

const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid({ result, onCellEdit, primaryKeyColumns = [], editable = false, selectable, onSelectionChange, columns, onDeleteRows, onDuplicateRow, hiddenColumns, pendingChanges, insertDrafts, insertDraftAnchors, includeRowIndexInId, onSortActiveChange }: Props, ref) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [cellEditor, setCellEditor] = useState<CellEditorState | null>(null)
  const anchorRowIndex = useRef<number | null>(null)
  const agApiRef = useRef<GridApi | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeCellRef = useRef<ActiveCell | null>(null)
  const autoSizedCols = useRef(new Set<string>())
  const lastHeaderClick = useRef<{ colId: string; time: number } | null>(null)

  const visibleColumns = useMemo(() =>
    hiddenColumns?.size ? result.columns.filter(col => !hiddenColumns.has(col)) : result.columns,
    [result.columns, hiddenColumns]
  )

  const isAnySortPresent = useCallback(() =>
    agApiRef.current?.getColumnState().some(col => !!col.sort) ?? false,
    []
  )

  const emitSortActiveChange = useCallback(() => {
    onSortActiveChange?.(isAnySortPresent())
  }, [isAnySortPresent, onSortActiveChange])

  useImperativeHandle(ref, () => ({
    isAnyFilterPresent: () => agApiRef.current?.isAnyFilterPresent() ?? false,
    isAnySortPresent,
    getFilteredData: () => {
      const rows: unknown[][] = []
      agApiRef.current?.forEachNodeAfterFilterAndSort(node => {
        if (node.data) rows.push(visibleColumns.map(col => node.data[col] ?? null))
      })
      return { columns: visibleColumns, rows }
    },
    stopEditing: () => { agApiRef.current?.stopEditing() },
    deselectAll: () => { agApiRef.current?.deselectAll() },
    clearSort: () => {
      agApiRef.current?.applyColumnState({ defaultState: { sort: null } })
      onSortActiveChange?.(false)
    },
  }), [isAnySortPresent, onSortActiveChange, visibleColumns])

  const pendingChangesRef = useRef(pendingChanges)
  pendingChangesRef.current = pendingChanges

  // Refresh cell styles whenever pending changes update
  useEffect(() => {
    agApiRef.current?.refreshCells({ force: true })
  }, [pendingChanges, insertDrafts])

  const columnDefs = useMemo(() =>
    result.columns.map((col, colIdx) => {
      const sampledCellWidth = result.rows
        .slice(0, COLUMN_WIDTH_SAMPLE_SIZE)
        .reduce((max, row) => Math.max(max, displayLength(row[colIdx])), 0)

      return {
        field: col,
        headerName: col,
        headerTooltip: col,
        tooltipField: col,
        editable: editable && col !== '__rowIndex',
        resizable: true,
        sortable: true,
        filter: true,
        hide: hiddenColumns?.has(col) ?? false,
        // Reserve fixed room for filter/sort/multi-sort indicators so labels do not disappear behind controls.
        minWidth: Math.ceil(Math.max(120, col.length * 7.5 + 104, Math.min(sampledCellWidth, 36) * 7.2 + 32)),
        cellStyle: (params: CellClassParams<Record<string, unknown>>) => {
          const base = { fontFamily: 'ui-monospace, monospace', fontSize: '12px' }
          const rowId = params.data?.__ag_rowId as string | undefined
          if (params.data?.__lagun_insertDraft) {
            return { ...base, backgroundColor: '#064e3b', color: '#bbf7d0' }
          }
          if (rowId && pendingChangesRef.current?.get(rowId)?.changes[col] !== undefined) {
            return { ...base, backgroundColor: '#7c3a00', color: '#fed7aa' }
          }
          return base
        },
        headerClass: 'text-xs font-semibold',
      }
    }),
    [result.columns, result.rows, editable, hiddenColumns]
  )

  const rowData = useMemo(() => buildResultGridRowData({
    result,
    primaryKeyColumns,
    pendingChanges,
    insertDrafts,
    insertDraftAnchors,
    includeRowIndexInId,
  }), [result, primaryKeyColumns, pendingChanges, insertDrafts, insertDraftAnchors, includeRowIndexInId])

  const getRowId = useCallback((params: { data: Record<string, unknown> }) =>
    params.data.__ag_rowId as string,
    []
  )

  const rowSelectionConfig = useMemo(() =>
    selectable
      ? { mode: 'multiRow' as const, checkboxes: true, headerCheckbox: true, enableClickSelection: false }
      : undefined,
    [selectable]
  )

  const defaultColDef = useMemo(() => ({
    minWidth: 80,
    flex: 1,
  }), [])

  const canEditColumn = useCallback((columnName: string) =>
    editable && columnName !== '__rowIndex',
    [editable]
  )

  const openLargeCellEditor = useCallback((cell: Pick<ActiveCell, 'columnName' | 'value' | 'data'>) => {
    if (!canEditColumn(cell.columnName)) return
    setCellEditor({
      columnName: cell.columnName,
      oldValue: cell.value,
      data: cell.data,
      value: cell.value == null ? '' : String(cell.value),
      wasNull: cell.value === null,
    })
    setMenu(null)
  }, [canEditColumn])

  const rememberActiveCell = useCallback((cell: ActiveCell | null) => {
    activeCellRef.current = cell
  }, [])

  const handleCellClicked = useCallback((e: CellClickedEvent<Record<string, unknown>>) => {
    if (!e.colDef.field || e.rowIndex == null || !e.data) return
    rememberActiveCell({
      rowIndex: e.rowIndex,
      columnName: e.colDef.field,
      value: e.value,
      data: e.data,
    })
  }, [rememberActiveCell])

  const handleCellFocused = useCallback((e: CellFocusedEvent) => {
    if (e.rowIndex == null || !e.column) return
    const columnName = typeof e.column === 'string' ? e.column : e.column.getColId()
    const row = e.api.getDisplayedRowAtIndex(e.rowIndex)
    const data = row?.data as Record<string, unknown> | undefined
    if (!data) return
    rememberActiveCell({
      rowIndex: e.rowIndex,
      columnName,
      value: data[columnName],
      data,
    })
  }, [rememberActiveCell])

  const onCellValueChanged = useCallback((params: CellValueChangedEvent) => {
    if (!onCellEdit || !params.colDef.field) return
    const activeCell = activeCellRef.current
    if (
      activeCell &&
      activeCell.columnName === params.colDef.field &&
      activeCell.rowIndex === params.rowIndex
    ) {
      activeCellRef.current = { ...activeCell, value: params.newValue, data: params.data as Record<string, unknown> }
    }
    onCellEdit({
      column: params.colDef.field,
      newValue: params.newValue,
      oldValue: params.oldValue,
      data: params.data as Record<string, unknown>,
    })
  }, [onCellEdit])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return
      const root = rootRef.current
      if (!root || !root.contains(document.activeElement)) return
      if ((agApiRef.current?.getEditingCells().length ?? 0) > 0) return

      const activeCell = activeCellRef.current
      if (!activeCell) return

      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'c') {
        e.preventDefault()
        clipboardWrite(String(activeCell.value ?? '')).catch(() => {})
        return
      }

      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter') {
        if (!canEditColumn(activeCell.columnName)) return
        e.preventDefault()
        openLargeCellEditor(activeCell)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canEditColumn, openLargeCellEditor])

  const handleSelectionChanged = useCallback((e: { api: { getSelectedRows: () => Record<string, unknown>[] } }) => {
    onSelectionChange?.(e.api.getSelectedRows())
  }, [onSelectionChange])

  const handleRowClicked = useCallback((e: RowClickedEvent) => {
    const native = e.event as MouseEvent | null
    if (!native?.shiftKey) {
      anchorRowIndex.current = e.rowIndex ?? null
      return
    }
    const current = e.rowIndex ?? 0
    const anchor = anchorRowIndex.current ?? current
    const from = Math.min(anchor, current)
    const to = Math.max(anchor, current)
    e.api.deselectAll()
    e.api.forEachNode(node => {
      if (node.rowIndex !== null && node.rowIndex >= from && node.rowIndex <= to) {
        node.setSelected(true)
      }
    })
  }, [])

  const handleHeaderDoubleClicked = useCallback((params: { column: { getColId: () => string; getActualWidth: () => number }; api: GridApi }) => {
    const colId = params.column.getColId()
    if (autoSizedCols.current.has(colId)) {
      params.api.applyColumnState({ state: [{ colId, flex: 1 }] })
      autoSizedCols.current.delete(colId)
    } else {
      params.api.autoSizeColumn(colId)
      if (params.column.getActualWidth() > 400) params.api.setColumnWidth(colId, 400)
      autoSizedCols.current.add(colId)
    }
  }, [])

  const handleCellDoubleClicked = useCallback((e: CellDoubleClickedEvent<Record<string, unknown>>) => {
    if (!e.colDef.field || e.rowIndex == null || !e.data || !canEditColumn(e.colDef.field)) return

    const cell: ActiveCell = {
      rowIndex: e.rowIndex,
      columnName: e.colDef.field,
      value: e.value,
      data: e.data,
    }
    rememberActiveCell(cell)

    if (valueNeedsLargeEditor(e.value, e.event?.target ?? null)) {
      openLargeCellEditor(cell)
      return
    }

    e.api.startEditingCell({ rowIndex: e.rowIndex, colKey: e.colDef.field })
  }, [canEditColumn, openLargeCellEditor, rememberActiveCell])

  const handleColumnHeaderClicked = useCallback((e: ColumnHeaderClickedEvent) => {
    if (!('getActualWidth' in e.column)) return  // skip column groups
    const col = e.column
    const colId = col.getColId()
    const now = Date.now()
    if (lastHeaderClick.current?.colId === colId && now - lastHeaderClick.current.time < 300) {
      handleHeaderDoubleClicked({ column: col, api: e.api })
      lastHeaderClick.current = null
    } else {
      lastHeaderClick.current = { colId, time: now }
    }
  }, [handleHeaderDoubleClicked])

  const handleColumnResized = useCallback((e: { finished: boolean; source: string; column?: { getColId: () => string } | null }) => {
    if (e.finished && e.source === 'uiColumnDragged' && e.column) {
      autoSizedCols.current.delete(e.column.getColId())
    }
  }, [])

  const handleCellContextMenu = useCallback((e: CellContextMenuEvent) => {
    const native = e.event as MouseEvent | null
    if (!native) return
    native.preventDefault()
    const selected: Record<string, unknown>[] = e.api.getSelectedRows()
    setMenu({
      x: native.clientX,
      y: native.clientY,
      columnName: e.colDef.field ?? '',
      cellValue: e.value,
      rowData: (e.data ?? {}) as Record<string, unknown>,
      selectedRows: selected,
    })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menu) return []
    const colInfo = columns?.find(c => c.name === menu.columnName)
    const isDateType = colInfo && DATE_TYPES.has(colInfo.data_type.toLowerCase())
    const validRowIds = new Set(rowData.map(r => r.__ag_rowId as string))
    const selected = menu.selectedRows.filter(r =>
      validRowIds.has(r.__ag_rowId as string) && !r.__lagun_insertDraft
    )
    const targetRows = selected.length > 0 ? selected : [menu.rowData]
    const displayRow = { ...menu.rowData }
    delete displayRow.__ag_rowId
    delete displayRow.__lagun_insertDraft

    const items: ContextMenuItem[] = [
      {
        type: 'item',
        label: 'Copy cell',
        icon: <Copy size={12} />,
        onClick: () => { clipboardWrite(String(menu.cellValue ?? '')).catch(() => {}); closeMenu() },
      },
      {
        type: 'item',
        label: 'Copy row as JSON',
        icon: <Braces size={12} />,
        onClick: () => { clipboardWrite(JSON.stringify(displayRow, null, 2)).catch(() => {}); closeMenu() },
      },
    ]

    if (editable) {
      items.push({ type: 'separator' })
      items.push({
        type: 'item',
        label: 'Edit cell...',
        icon: <PencilLine size={12} />,
        onClick: () => openLargeCellEditor({
          columnName: menu.columnName,
          value: menu.cellValue,
          data: menu.rowData,
        }),
      })
      if (colInfo?.is_nullable) {
        items.push({
          type: 'item',
          label: 'Set to NULL',
          icon: <Slash size={12} />,
          onClick: () => { onCellEdit?.({ column: menu.columnName, newValue: null, oldValue: menu.rowData[menu.columnName], data: menu.rowData }); closeMenu() },
        })
      }
      if (isDateType) {
        const nowStr = localNow(colInfo!.data_type.toLowerCase())
        items.push({
          type: 'item',
          label: `Set to NOW()  ${nowStr}`,
          icon: <Clock size={12} />,
          onClick: () => { onCellEdit?.({ column: menu.columnName, newValue: nowStr, oldValue: menu.rowData[menu.columnName], data: menu.rowData }); closeMenu() },
        })
      }
    }

    if (editable && onDuplicateRow && !menu.rowData.__lagun_insertDraft) {
      items.push({ type: 'separator' })
      items.push({
        type: 'item',
        label: 'Duplicate row with keys',
        icon: <CopyPlus size={12} />,
        onClick: () => { onDuplicateRow(menu.rowData, 'withKeys'); closeMenu() },
      })
      items.push({
        type: 'item',
        label: 'Duplicate row without keys',
        icon: <CopyPlus size={12} />,
        onClick: () => { onDuplicateRow(menu.rowData, 'withoutKeys'); closeMenu() },
      })
    }

    if (onDeleteRows && primaryKeyColumns.length > 0 && !menu.rowData.__lagun_insertDraft) {
      const label = targetRows.length > 1 ? `Delete ${targetRows.length} rows` : 'Delete row'
      items.push({ type: 'separator' })
      items.push({
        type: 'item',
        label,
        danger: true,
        icon: <Trash2 size={12} />,
        onClick: () => { onDeleteRows(targetRows); closeMenu() },
      })
    }

    return items
  }, [menu, columns, editable, onCellEdit, onDeleteRows, onDuplicateRow, primaryKeyColumns, closeMenu, rowData, openLargeCellEditor])

  const handleApplyCellEditor = useCallback(() => {
    if (!cellEditor) return
    onCellEdit?.({
      column: cellEditor.columnName,
      newValue: cellEditor.value,
      oldValue: cellEditor.oldValue,
      data: cellEditor.data,
    })
    setCellEditor(null)
  }, [cellEditor, onCellEdit])

  if (result.error) {
    return (
      <div className="p-4 bg-red-950/50 border border-red-800 rounded m-3">
        <p className="text-xs font-mono text-red-300">{result.error}</p>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="h-full lagun-result-grid">
      <AgGridReact
        theme={darkTheme}
        columnDefs={columnDefs}
        rowData={rowData}
        getRowId={getRowId}
        onGridReady={e => { agApiRef.current = e.api; emitSortActiveChange() }}
        onSortChanged={emitSortActiveChange}
        onCellClicked={handleCellClicked}
        onCellFocused={handleCellFocused}
        onCellDoubleClicked={handleCellDoubleClicked}
        onCellValueChanged={onCellValueChanged}
        onSelectionChanged={handleSelectionChanged}
        onRowClicked={selectable ? handleRowClicked : undefined}
        onColumnHeaderClicked={handleColumnHeaderClicked}
        onColumnResized={handleColumnResized}
        onCellContextMenu={handleCellContextMenu}
        onBodyScroll={closeMenu}
        defaultColDef={defaultColDef}
        rowSelection={rowSelectionConfig}
        suppressContextMenu
        preventDefaultOnContextMenu
        stopEditingWhenCellsLoseFocus
        suppressClickEdit
        alwaysMultiSort
        sortingOrder={['asc', 'desc', null]}
      />
      {menu && (
        <GridContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {cellEditor && (
        <Modal
          open={!!cellEditor}
          onClose={() => setCellEditor(null)}
          title="Edit cell"
          width="max-w-3xl"
          footer={(
            <>
              <Button variant="secondary" onClick={() => setCellEditor(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleApplyCellEditor}>Apply</Button>
            </>
          )}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-slate-300">{cellEditor.columnName}</span>
              {cellEditor.wasNull && (
                <span className="px-1.5 py-0.5 rounded bg-surface-800 border border-surface-700 text-slate-400">
                  NULL
                </span>
              )}
            </div>
            <textarea
              className="w-full min-h-[320px] resize-y rounded-md border border-surface-700 bg-surface-950 px-3 py-2 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              value={cellEditor.value}
              onChange={e => setCellEditor(prev => prev ? { ...prev, value: e.target.value } : prev)}
              spellCheck={false}
              autoFocus
            />
          </div>
        </Modal>
      )}
    </div>
  )
})

export default ResultGrid
