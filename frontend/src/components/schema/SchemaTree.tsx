import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Database, Table2, Terminal, Trash2, Scissors, Upload, Search, X, Star } from 'lucide-react'
import { useSchemaStore } from '../../store/schemaStore'
import { useTabStore } from '../../store/tabStore'
import { api } from '../../api/client'
import type { TableInfo } from '../../types'
import ImportDialog from '../table/ImportDialog'
import ConfirmDialog from '../ui/ConfirmDialog'
import { showToast } from '../../utils/toast'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'
import Spinner from '../ui/Spinner'
import RefreshIcon from '../ui/RefreshIcon'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'

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
  const { databases, loadDatabases, loadTables, tables, invalidateSession, loadingDbs, loadingTables } = useSchemaStore()
  const { openTableTab, openQueryTab } = useTabStore()
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [showBookmarksOnly, setShowBookmarksOnly] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; db: string; table?: string
  } | null>(null)
  const [importTarget, setImportTarget] = useState<{ db: string; table: string } | null>(null)
  const [destructiveTarget, setDestructiveTarget] = useState<{ action: 'truncate' | 'drop'; db: string; table: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { bookmarks, toggle: toggleBookmark, isBookmarked } = useBookmarks(sessionId)
  const allDbs = databases[sessionId] ?? []
  const dbs = selectedDatabases && selectedDatabases.length > 0
    ? allDbs.filter(db => selectedDatabases.includes(db))
    : allDbs
  const hasSchemaSelection = Boolean(selectedDatabases?.length)
  const expandedSearchDbs = dbs.filter(db => expandedDbs.has(db))
  const searchScopeDbs = query && expandedSearchDbs.length > 0 ? expandedSearchDbs : dbs
  const searchPlaceholder = showBookmarksOnly
    ? 'Filter bookmarks...'
    : query && expandedSearchDbs.length > 0
      ? `Filter ${expandedSearchDbs.length === 1 ? expandedSearchDbs[0] : `${expandedSearchDbs.length} open schemas`}`
      : hasSchemaSelection
        ? 'Filter selected schemas...'
        : 'Filter tables...'

  useEffect(() => {
    loadDatabases(sessionId)
  }, [sessionId, loadDatabases])

  // Reset bookmark view when switching sessions
  useEffect(() => {
    setShowBookmarksOnly(false)
    setQuery('')
  }, [sessionId])

  const refresh = async () => {
    const openDatabases = [...expandedDbs]
    // Close visible groups while their contents refresh, then restore them so
    // the existing grid-row transition communicates that fresh tables arrived.
    setExpandedDbs(new Set())
    invalidateSession(sessionId)
    const refreshedDatabases = await loadDatabases(sessionId)
    await Promise.all(
      openDatabases
        .filter(db => refreshedDatabases.includes(db))
        .map(db => loadTables(sessionId, db)),
    )
    setExpandedDbs(new Set(openDatabases.filter(db => refreshedDatabases.includes(db))))
    setQuery('')
  }

  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (q) {
      const scopeDbs = expandedDbs.size > 0 ? dbs.filter(db => expandedDbs.has(db)) : dbs
      scopeDbs.forEach(db => {
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

  const q = query.toLowerCase()
  const visibleDbs = searchScopeDbs.map(db => {
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
    ;(e.currentTarget as HTMLElement).focus()
    setContextMenu({ x: e.clientX, y: e.clientY, db, table })
  }

  const closeMenu = () => setContextMenu(null)
  useMenuKeyboard(menuRef, closeMenu, Boolean(contextMenu))

  const dropTable = async (db: string, table: string) => {
    try {
      await api.dropTable(sessionId, db, table)
      const key = `${sessionId}/${db}`
      useSchemaStore.setState(s => ({
        tables: { ...s.tables, [key]: (s.tables[key] ?? []).filter(t => t.name !== table) }
      }))
      showToast(`Dropped ${db}.${table}.`)
    } catch (error) {
      showToast(`Could not drop ${db}.${table}: ${error}`, 'error')
    }
  }

  const truncateTable = async (db: string, table: string) => {
    try {
      await api.truncateTable(sessionId, db, table)
      showToast(`Truncated ${db}.${table}.`)
    } catch (error) {
      showToast(`Could not truncate ${db}.${table}: ${error}`, 'error')
    }
  }

  const confirmDestructiveAction = async () => {
    if (!destructiveTarget) return
    const { action, db, table } = destructiveTarget
    setDestructiveTarget(null)
    if (action === 'drop') await dropTable(db, table)
    else await truncateTable(db, table)
  }

  const noBookmarks = showBookmarksOnly && bookmarks.size === 0

  return (
    <div className="flex h-full min-h-0 flex-col py-1" onClick={closeMenu}>
      <div className="flex flex-shrink-0 items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Databases</span>
        <div className="flex items-center gap-1">
          <m.button
            onClick={handleToggleBookmarksOnly}
            title={showBookmarksOnly ? 'Show all tables' : 'Show bookmarks only'}
            whileTap={{ scale: 0.78, rotate: -12 }}
            animate={{ scale: showBookmarksOnly ? 1.12 : 1, rotate: showBookmarksOnly ? 8 : 0 }}
            transition={surfaceTransition}
            className={`p-0.5 transition-colors ${showBookmarksOnly ? 'text-yellow-400' : 'text-slate-500 hover:text-slate-300'}`}
          >
            <Star size={10} fill={showBookmarksOnly ? 'currentColor' : 'none'} />
          </m.button>
          <m.button
            onClick={refresh}
            whileTap={{ scale: 0.9 }}
            transition={surfaceTransition}
            disabled={loadingDbs.has(sessionId)}
            className="rounded p-0.5 text-slate-500 hover:text-slate-300 transition-colors disabled:cursor-wait"
            aria-label="Refresh databases"
          >
            <RefreshIcon refreshing={loadingDbs.has(sessionId)} size={10} />
          </m.button>
        </div>
      </div>

      <div className="flex-shrink-0 px-2 pb-1">
        <div className="flex items-center gap-1.5 bg-surface-800 rounded px-2 py-1">
          <Search size={10} className="text-slate-500 flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              setQuery('')
              e.currentTarget.blur()
            }}
            placeholder={searchPlaceholder}
            className="bg-transparent text-xs text-slate-300 placeholder-slate-600 flex-1 outline-none min-w-0"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-500 hover:text-slate-300">
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence initial={false} mode="wait">
        <m.div
          key={showBookmarksOnly ? 'bookmarks' : 'all-tables'}
          initial={{ opacity: 0, x: showBookmarksOnly ? motionDistance.surface : -motionDistance.surface }}
          animate={{ opacity: 1, x: 0, transition: surfaceTransition }}
          exit={{ opacity: 0, x: showBookmarksOnly ? -motionDistance.surface : motionDistance.surface, transition: exitTransition }}
        >
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
                <div className="group flex items-center hover:bg-surface-800">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-slate-300"
                    onClick={() => toggleDb(db)}
                    onContextMenu={e => handleTableContext(e, db)}
                    title={db}
                  >
                    {loadingTables.has(`${sessionId}/${db}`)
                      ? <Spinner size="sm" className="flex-shrink-0" />
                      : <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} />}
                    <Database size={12} className="flex-shrink-0 text-yellow-400" />
                    <span className="text-xs truncate flex-1 text-left">{db}</span>
                  </button>
                  <button
                    type="button"
                    title="New query on this database"
                    aria-label={`New query on ${db}`}
                    onClick={() => openQueryTab(sessionId, db)}
                    className="mr-1 rounded p-1 text-slate-500 opacity-0 transition-opacity hover:text-brand-400 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 group-hover:opacity-100"
                  >
                    <Terminal size={10} />
                  </button>
                </div>

                <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                {tbls.map(tbl => {
                  const starred = isBookmarked(db, tbl.name)
                  return (
                    <div key={tbl.name} className="group flex items-center hover:bg-surface-800">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-7 pr-2 text-slate-400 hover:text-slate-200"
                        onClick={() => openTableTab(sessionId, db, tbl.name)}
                        onContextMenu={e => handleTableContext(e, db, tbl.name)}
                        title={`${db}.${tbl.name}`}
                      >
                        <Table2 size={11} className="flex-shrink-0 text-slate-500" />
                        <span className="text-xs truncate flex-1 text-left">{tbl.name}</span>
                      </button>
                      <m.button
                        type="button"
                        title={starred ? 'Remove bookmark' : 'Bookmark table'}
                        aria-label={`${starred ? 'Remove bookmark from' : 'Bookmark'} ${db}.${tbl.name}`}
                        onClick={() => toggleBookmark(db, tbl.name)}
                        whileTap={{ scale: 0.7, rotate: -18 }}
                        animate={{ scale: starred ? [1, 1.45, 1] : 1, rotate: starred ? [0, 14, 0] : 0 }}
                        transition={{ duration: 0.28, ease: 'easeOut' }}
                        className={`mr-1 rounded p-1 transition-colors hover:text-yellow-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${starred ? 'text-yellow-400' : 'text-slate-500 opacity-0 focus:opacity-100 group-hover:opacity-100'}`}
                      >
                        <Star size={10} fill={starred ? 'currentColor' : 'none'} />
                      </m.button>
                    </div>
                  )
                })}
                </div>
                </div>
              </div>
            )
          })
        )}
        </m.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>
      {contextMenu && (
        <m.div
          ref={menuRef}
          role="menu"
          aria-label="Schema actions"
          initial={{ opacity: 0, scale: 0.9, y: -motionDistance.surface }}
          animate={{ opacity: 1, scale: 1, y: 0, transition: surfaceTransition }}
          exit={{ opacity: 0, scale: 0.92, y: -motionDistance.subtle, transition: exitTransition }}
          className="fixed z-popover w-44 rounded border border-surface-700 bg-surface-800 py-1 shadow-lg"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.table ? (
            <>
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { openTableTab(sessionId, contextMenu.db, contextMenu.table!); closeMenu() }}
              >
                <Table2 size={12} /> Open Table
              </button>
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { openQueryTab(sessionId, contextMenu.db); closeMenu() }}
              >
                <Terminal size={12} /> New Query
              </button>
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
                onClick={() => { setImportTarget({ db: contextMenu.db, table: contextMenu.table! }); closeMenu() }}
              >
                <Upload size={12} /> Import CSV
              </button>
              <hr className="border-surface-700 my-1" />
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-yellow-400"
                onClick={() => { setDestructiveTarget({ action: 'truncate', db: contextMenu.db, table: contextMenu.table! }); closeMenu() }}
              >
                <Scissors size={12} /> Truncate
              </button>
              <button
                role="menuitem"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-red-400"
                onClick={() => { setDestructiveTarget({ action: 'drop', db: contextMenu.db, table: contextMenu.table! }); closeMenu() }}
              >
                <Trash2 size={12} /> Drop Table
              </button>
            </>
          ) : (
            <button
              role="menuitem"
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-surface-700 text-slate-200"
              onClick={() => { openQueryTab(sessionId, contextMenu.db); closeMenu() }}
            >
              <Terminal size={12} /> New Query
            </button>
          )}
        </m.div>
      )}
      </AnimatePresence>

      {importTarget && (
        <ImportDialog
          open={!!importTarget}
          onClose={() => setImportTarget(null)}
          sessionId={sessionId}
          database={importTarget.db}
          table={importTarget.table}
        />
      )}
      <ConfirmDialog
        open={Boolean(destructiveTarget)}
        title={destructiveTarget?.action === 'drop' ? 'Drop Table' : 'Truncate Table'}
        message={destructiveTarget?.action === 'drop'
          ? `Drop ${destructiveTarget.db}.${destructiveTarget.table}? This cannot be undone.`
          : `Truncate ${destructiveTarget?.db}.${destructiveTarget?.table}? All rows will be deleted.`}
        confirmLabel={destructiveTarget?.action === 'drop' ? 'Drop Table' : 'Truncate Table'}
        danger
        onConfirm={confirmDestructiveAction}
        onClose={() => setDestructiveTarget(null)}
      />
    </div>
  )
}
