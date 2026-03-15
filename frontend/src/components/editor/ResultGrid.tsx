import { useMemo, useCallback, useState, useRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { themeQuartz } from 'ag-grid-community'
import { Copy, Braces, Slash, Clock, Trash2 } from 'lucide-react'
import type { CellContextMenuEvent, RowClickedEvent } from 'ag-grid-community'
import GridContextMenu, { type ContextMenuItem } from './GridContextMenu'
import type { QueryResult, ColumnInfo } from '../../types'

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

function localNow(dataType: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  if (dataType === 'date') return date
  if (dataType === 'time') return time
  return `${date} ${time}`
}

interface MenuState {
  x: number
  y: number
  columnName: string
  cellValue: unknown
  rowData: Record<string, unknown>
  selectedRows: Record<string, unknown>[]
}

interface Props {
  result: QueryResult
  onCellEdit?: (params: {
    column: string
    newValue: unknown
    data: Record<string, unknown>
  }) => void
  primaryKeyColumns?: string[]
  editable?: boolean
  selectable?: boolean
  onSelectionChange?: (rows: Record<string, unknown>[]) => void
  columns?: ColumnInfo[]
  onDeleteRows?: (rows: Record<string, unknown>[]) => void
}

export default function ResultGrid({ result, onCellEdit, primaryKeyColumns = [], editable = false, selectable, onSelectionChange, columns, onDeleteRows }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const anchorRowIndex = useRef<number | null>(null)

  const columnDefs = useMemo(() =>
    result.columns.map(col => ({
      field: col,
      headerName: col,
      editable: editable && col !== '__rowIndex',
      resizable: true,
      sortable: true,
      filter: true,
      cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
      headerClass: 'text-xs font-semibold',
    })),
    [result.columns, editable]
  )

  const rowData = useMemo(() =>
    result.rows.map((row, rowIdx) => {
      const obj: Record<string, unknown> = { __ag_rowId: String(rowIdx) }
      result.columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    }),
    [result.rows, result.columns]
  )

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

  const onCellValueChanged = useCallback((params: { colDef: { field?: string }; newValue: unknown; data: Record<string, unknown> }) => {
    if (!onCellEdit || !params.colDef.field) return
    onCellEdit({
      column: params.colDef.field,
      newValue: params.newValue,
      data: params.data,
    })
  }, [onCellEdit])

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
    const targetRows = menu.selectedRows.length > 0 ? menu.selectedRows : [menu.rowData]
    const { __ag_rowId, ...displayRow } = menu.rowData

    const items: ContextMenuItem[] = [
      {
        type: 'item',
        label: 'Copy cell',
        icon: <Copy size={12} />,
        onClick: () => { navigator.clipboard.writeText(String(menu.cellValue ?? '')); closeMenu() },
      },
      {
        type: 'item',
        label: 'Copy row as JSON',
        icon: <Braces size={12} />,
        onClick: () => { navigator.clipboard.writeText(JSON.stringify(displayRow, null, 2)); closeMenu() },
      },
    ]

    if (editable) {
      if (colInfo?.is_nullable) {
        items.push({ type: 'separator' })
        items.push({
          type: 'item',
          label: 'Set to NULL',
          icon: <Slash size={12} />,
          onClick: () => { onCellEdit?.({ column: menu.columnName, newValue: null, data: menu.rowData }); closeMenu() },
        })
      }
      if (isDateType) {
        const nowStr = localNow(colInfo!.data_type.toLowerCase())
        items.push({
          type: 'item',
          label: `Set to NOW()  ${nowStr}`,
          icon: <Clock size={12} />,
          onClick: () => { onCellEdit?.({ column: menu.columnName, newValue: nowStr, data: menu.rowData }); closeMenu() },
        })
      }
    }

    if (onDeleteRows && primaryKeyColumns.length > 0) {
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
  }, [menu, columns, editable, onCellEdit, onDeleteRows, primaryKeyColumns, closeMenu])

  if (result.error) {
    return (
      <div className="p-4 bg-red-950/50 border border-red-800 rounded m-3">
        <p className="text-xs font-mono text-red-300">{result.error}</p>
      </div>
    )
  }

  return (
    <div className="h-full">
      <AgGridReact
        theme={darkTheme}
        columnDefs={columnDefs}
        rowData={rowData}
        getRowId={getRowId}
        onCellValueChanged={onCellValueChanged}
        onSelectionChanged={handleSelectionChanged}
        onRowClicked={selectable ? handleRowClicked : undefined}
        onCellContextMenu={handleCellContextMenu}
        onBodyScroll={closeMenu}
        defaultColDef={defaultColDef}
        rowSelection={rowSelectionConfig}
        suppressContextMenu
        preventDefaultOnContextMenu
        singleClickEdit
        stopEditingWhenCellsLoseFocus
      />
      {menu && (
        <GridContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
