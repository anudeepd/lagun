import { useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, Database, Table2, Terminal, RefreshCw, Trash2, Scissors, Upload, Search, X, Star } from 'lucide-react'
import { useSchemaStore } from '../../store/schemaStore'
import { useTabStore } from '../../store/tabStore'
import { api } from '../../api/client'
import type { TableInfo } from '../../types'
import ImportDialog from '../table/ImportDialog'

interface Props {
  sessionId: string
  selectedDatabases?: string[]
}

function useBookmarks(sessionId: string) {
  const key = `lagun-bookmarks-${sessionId}`
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(key)
      return new Set(stored ? JSON.parse(stored) : [])
    } catch {
      return new Set()
    }
  })

  const toggle = (db: string, table: string) => {
    const id = `${db}/${table}`
    setBookmarks(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(key, JSON.stringify([...next]))
      return next
    })
  }

  const isBookmarked = (db: string, table: string) => bookmarks.has(`${db}/${table}`)

  return { bookmarks, toggle, isBookmarked }
}

export default function SchemaTree({ sessionId, selectedDatabases }: Props) {
  const { databases, loadDatabases, loadTables, tables, invalidateSession } = useSchemaStore()
  const { openTableTab, openQueryTab } = useTabStore()
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [showBookmarksOnly, setShowBookmarksOnly] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; db: string; table?: string
  } | null>(null)
  const [importTarget, setImportTarget] = useState<{ db: string; table: string } | null>(null)
  const { bookmarks, toggle: toggleBookmark, isBookmarked } = useBookmarks(sessionId)

  useEffect(() => {
    loadDatabases(sessionId)
  }, [sessionId, loadDatabases])

  // Reset bookmark view when switching sessions
  useEffect(() => {
    setShowBookmarksOnly(false)
    setQuery('')
  }, [sessionId])

  const refresh = () => {
    invalidateSession(sessionId)
    loadDatabases(sessionId)
    setExpandedDbs(new Set())
    setQuery('')
  }

  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (q) {
      dbs.forEach(db => {
        setExpandedDbs(prev => new Set([...prev, db]))
        if (!tables[`${sessionId}/${db}`]) loadTables(sessionId, db)
      })
    }
  }

  const toggleDb = async (db: string) => {
    const next = new Set(expandedDbs)
    if (next.has(db)) {
      next.delete(db)
    } else {
      next.add(db)
      await loadTables(sessionId, db)
    }
    setExpandedDbs(next)
  }

  const handleToggleBookmarksOnly = () => {
    const next = !showBookmarksOnly
    setShowBookmarksOnly(next)
    // When switching to bookmark view, expand all DBs that have bookmarks
    if (next) {
      dbs.forEach(db => {
        const hasBm = [...bookmarks].some(b => b.startsWith(`${db}/`))
        if (hasBm) {
          setExpandedDbs(prev => new Set([...prev, db]))
          if (!tables[`${sessionId}/${db}`]) loadTables(sessionId, db)
        }
      })
    }
  }

  const allDbs = databases[sessionId] ?? []
  const dbs = selectedDatabases && selectedDatabases.length > 0
    ? allDbs.filter(db => selectedDatabases.includes(db))
    : allDbs

  const q = query.toLowerCase()
  const visibleDbs = dbs.map(db => {
    const tbls: TableInfo[] = tables[`${sessionId}/${db}`] ?? []
    let filtered = tbls
    if (showBookmarksOnly) filtered = filtered.filter(t => isBookmarked(db, t.name))
    if (q) filtered = filtered.filter(t => t.name.toLowerCase().includes(q))
    return { db, tbls: filtered }
  }).filter(({ db, tbls }) => {
    if (showBookmarksOnly) return tbls.length > 0
    return !q || tbls.length > 0 || db.toLowerCase().includes(q)
  })

  const handleTableContext = (e: React.MouseEvent, db: string, table?: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, db, table })
  }

  const closeMenu = () => setContextMenu(null)

  const dropTable = async (db: string, table: string) => {
    if (!confirm(`Drop table ${db}.${table}? This cannot be undone.`)) return
    await api.dropTable(sessionId, db, table)
    const key = `${sessionId}/${db}`
    useSchemaStore.setState(s => ({
      tables: { ...s.tables, [key]: (s.tables[key] ?? []).filter(t => t.name !== table) }
    }))
    closeMenu()
  }

  const truncateTable = async (db: string, table: string) => {
    if (!confirm(`Truncate table ${db}.${table}? All rows will be deleted.`)) return
    await api.truncateTable(sessionId, db, table)
    closeMenu()
  }

  const noBookmarks = showBookmarksOnly && bookmarks.size === 0

  return (
    <div className="py-1" onClick={closeMenu}>
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Databases</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleBookmarksOnly}
            title={showBookmarksOnly ? 'Show all tables' : 'Show bookmarks only'}
            className={`p-0.5 transition-colors ${showBookmarksOnly ? 'text-yellow-400' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <Star size={10} fill={showBookmarksOnly ? 'currentColor' : 'none'} />
          </button>
          <button onClick={refresh} className="p-0.5 text-slate-500 hover:text-slate-300 transition-colors">
            <RefreshCw size={10} />
          </button>
        </div>
      </div>

      <div className="px-2 pb-1">
        <div className="flex items-center gap-1.5 bg-surface-800 rounded px-2 py-1">
          <Search size={10} className="text-slate-500 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            placeholder={showBookmarksOnly ? 'Filter bookmarks…' : 'Filter tables…'}
            className="bg-transparent text-xs text-slate-300 placeholder-slate-600 flex-1 outline-none min-w-0"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-500 hover:text-slate-300">
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {noBookmarks ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Star size={18} className="text-slate-700" />
          <p className="text-xs text-slate-600">No bookmarks yet.<br />Hover a table and click ★ to add one.</p>
        </div>
      ) : (
        visibleDbs.map(({ db, tbls }) => {
          const isOpen = expandedDbs.has(db)

          return (
            <div key={db}>
              <button
                className="flex items-center gap-1.5 w-full px-2 py-1 hover:bg-surface-800 text-slate-300 group"
                onClick={() => toggleDb(db)}
                onContextMenu={e => handleTableContext(e, db)}
              >
                {isOpen ? <ChevronDown size={12} className="flex-shrink-0" /> : <ChevronRight size={12} className="flex-shrink-0" />}
                <Database size={12} className="flex-shrink-0 text-yellow-400" />
                <span className="text-xs truncate flex-1 text-left">{db}</span>
                <span
                  role="button"
                  title="New query on this database"
                  onClick={e => { e.stopPropagation(); openQueryTab(sessionId, db) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-brand-400"
                >
                  <Terminal size={10} />
                </span>
              </button>

              {isOpen && tbls.map(tbl => {
                const starred = isBookmarked(db, tbl.name)
                return (
                  <button
                    key={tbl.name}
                    className="flex items-center gap-1.5 w-full pl-7 pr-2 py-0.5 hover:bg-surface-800 text-slate-400 hover:text-slate-200 group"
                    onClick={() => openTableTab(sessionId, db, tbl.name)}
                    onContextMenu={e => handleTableContext(e, db, tbl.name)}
                  >
                    <Table2 size={11} className="flex-shrink-0 text-slate-500" />
                    <span className="text-xs truncate flex-1 text-left">{tbl.name}</span>
                    <span
                      role="button"
                      title={starred ? 'Remove bookmark' : 'Bookmark table'}
                      onClick={e => { e.stopPropagation(); toggleBookmark(db, tbl.name) }}
                      className={`p-0.5 transition-colors ${starred ? 'text-yellow-400' : 'opacity-0 group-hover:opacity-100 text-slate-500 hover:text-yellow-400'}`}
                    >
                      <Star size={10} fill={starred ? 'currentColor' : 'none'} />
                    </span>
                  </button>
                )
              })}
            </div>
          )
        })
      )}

      {contextMenu && (
        <div
          className="fixed bg-surface-800 border border-surface-700 rounded shadow-lg z-50 py-1 w-44"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.table ? (
            <>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { openTableTab(sessionId, contextMenu.db, contextMenu.table!); closeMenu() }}
              >
                <Table2 size={12} /> Open Table
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { openQueryTab(sessionId, contextMenu.db); closeMenu() }}
              >
                <Terminal size={12} /> New Query
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { setImportTarget({ db: contextMenu.db, table: contextMenu.table! }); closeMenu() }}
              >
                <Upload size={12} /> Import CSV
              </button>
              <hr className="border-surface-700 my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-yellow-400"
                onClick={() => truncateTable(contextMenu.db, contextMenu.table!)}
              >
                <Scissors size={12} /> Truncate
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-red-400"
                onClick={() => dropTable(contextMenu.db, contextMenu.table!)}
              >
                <Trash2 size={12} /> Drop Table
              </button>
            </>
          ) : (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
              onClick={() => { openQueryTab(sessionId, contextMenu.db); closeMenu() }}
            >
              <Terminal size={12} /> New Query
            </button>
          )}
        </div>
      )}

      {importTarget && (
        <ImportDialog
          open={!!importTarget}
          onClose={() => setImportTarget(null)}
          sessionId={sessionId}
          database={importTarget.db}
          table={importTarget.table}
        />
      )}
    </div>
  )
}
