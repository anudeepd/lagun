import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronRight, Database, Table2, Terminal, Trash2, Scissors, Upload, Search, X, Star, Plus } from 'lucide-react'
import { useSchemaStore } from '../../store/schemaStore'
import { useTabStore } from '../../store/tabStore'
import { api } from '../../api/client'
import type { TableInfo } from '../../types'
import ConfirmDialog from '../ui/ConfirmDialog'
import { showToast } from '../../utils/toast'
import useMenuKeyboard from '../../hooks/useMenuKeyboard'
import Spinner, { LoadingState } from '../ui/Spinner'
import RefreshIcon from '../ui/RefreshIcon'
import Tooltip from '../ui/Tooltip'
import { AnimatePresence } from 'motion/react'
import * as m from 'motion/react-m'
import { exitTransition, motionDistance, surfaceTransition } from '../../motion/tokens'
import Label from '../ui/Label'

const ImportDialog = lazy(() => import('../table/ImportDialog'))
const CreateTableDialog = lazy(() => import('../table/CreateTableDialog'))

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
    const next = new Set(bookmarks)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setBookmarks(next)
    // Outside the state updater: React may invoke an updater twice under
    // StrictMode, and a quota/private-mode SecurityError thrown from inside it
    // takes the whole sidebar down with it.
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // Persisting bookmarks is best-effort; the in-memory set still works.
    }
  }

  const isBookmarked = (db: string, table: string) => bookmarks.has(`${db}/${table}`)

  return { bookmarks, toggle, isBookmarked }
}

export default function SchemaTree({ sessionId, selectedDatabases }: Props) {
  const databases = useSchemaStore(s => s.databases)
  const dbErrors = useSchemaStore(s => s.dbErrors)
  const tables = useSchemaStore(s => s.tables)
  const loadDatabases = useSchemaStore(s => s.loadDatabases)
  const loadTables = useSchemaStore(s => s.loadTables)
  const loadTablesBatch = useSchemaStore(s => s.loadTablesBatch)
  const invalidateSession = useSchemaStore(s => s.invalidateSession)
  const loadingDbs = useSchemaStore(s => s.loadingDbs)
  const loadingTables = useSchemaStore(s => s.loadingTables)
  const openTableTab = useTabStore(s => s.openTableTab)
  const openQueryTab = useTabStore(s => s.openQueryTab)
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [showBookmarksOnly, setShowBookmarksOnly] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; db: string; table?: string
  } | null>(null)
  const [importTarget, setImportTarget] = useState<{ db: string; table: string } | null>(null)
  const [createTableTarget, setCreateTableTarget] = useState<{ db: string } | null>(null)
  const [destructiveTarget, setDestructiveTarget] = useState<{ action: 'truncate' | 'drop'; db: string; table: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { bookmarks, toggle: toggleBookmark, isBookmarked } = useBookmarks(sessionId)
  const allDbs = databases[sessionId] ?? []
  const dbError = dbErrors[sessionId]
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
    try {
      const refreshedDatabases = await loadDatabases(sessionId)
      await loadTablesBatch(
        sessionId,
        openDatabases.filter(db => refreshedDatabases.includes(db)),
      )
      setExpandedDbs(new Set(openDatabases.filter(db => refreshedDatabases.includes(db))))
      setQuery('')
    } catch (error) {
      // Without this the rejection escaped as an unhandled promise and every
      // expanded group stayed collapsed, with no explanation.
      showToast(
        `Could not refresh schemas: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      setExpandedDbs(new Set(openDatabases))
    }
  }

  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (q) {
      const scopeDbs = expandedDbs.size > 0 ? dbs.filter(db => expandedDbs.has(db)) : dbs
      setExpandedDbs(prev => new Set([...prev, ...scopeDbs]))
      loadTablesBatch(sessionId, scopeDbs)
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
      const bookmarkedDbs = dbs.filter(db => [...bookmarks].some(b => b.startsWith(`${db}/`)))
      setExpandedDbs(prev => new Set([...prev, ...bookmarkedDbs]))
      loadTablesBatch(sessionId, bookmarkedDbs)
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
    if (!q) return true
    // A schema whose table list has not arrived yet cannot be ruled out as a
    // match. Hiding it would blank the list and drop the schema name the
    // moment the user starts typing, so keep it visible (with its spinner)
    // until its tables are known.
    if (tables[`${sessionId}/${db}`] === undefined) return true
    return tbls.length > 0 || db.toLowerCase().includes(q)
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
        <Label as="span">Databases</Label>
        <div className="flex items-center gap-1">
          <Tooltip label={showBookmarksOnly ? 'Show all tables' : 'Show bookmarks only'}>
          <m.button
            onClick={handleToggleBookmarksOnly}
            whileTap={{ scale: 0.78, rotate: -12 }}
            animate={{ scale: showBookmarksOnly ? 1.12 : 1, rotate: showBookmarksOnly ? 8 : 0 }}
            transition={surfaceTransition}
            aria-label={showBookmarksOnly ? 'Show all tables' : 'Show bookmarks only'}
            aria-pressed={showBookmarksOnly}
            className={`lagun-hit-target transition-colors ${showBookmarksOnly ? 'text-yellow-400' : 'text-muted hover:text-slate-300'}`}
          >
            <Star size={10} aria-hidden="true" fill={showBookmarksOnly ? 'currentColor' : 'none'} />
          </m.button>
          </Tooltip>
          <Tooltip label="Refresh databases">
          <m.button
            onClick={refresh}
            whileTap={{ scale: 0.9 }}
            transition={surfaceTransition}
            disabled={loadingDbs.has(sessionId)}
            className="lagun-hit-target rounded text-muted hover:text-slate-300 transition-colors disabled:cursor-wait"
            aria-label="Refresh databases"
          >
            <RefreshIcon refreshing={loadingDbs.has(sessionId)} size={10} />
          </m.button>
          </Tooltip>
        </div>
      </div>

      {dbError && (
        <div role="alert" className="mx-2 mb-1 rounded border border-red-900/60 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300">
          <p className="leading-snug">Could not load databases: {dbError}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-1 font-medium text-red-200 underline underline-offset-2 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-shrink-0 px-2 pb-1">
        <div className="flex items-center gap-1.5 bg-surface-800 rounded px-2 py-1">
          <Search size={10} className="text-muted flex-shrink-0" />
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
            aria-label="Filter tables"
            className="bg-transparent text-xs text-slate-300 placeholder-muted flex-1 outline-none min-w-0"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="lagun-hit-target text-muted hover:text-slate-300"
            >
              <X size={10} aria-hidden="true" />
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
        {allDbs.length === 0 && !dbError && loadingDbs.has(sessionId) ? (
          <LoadingState label="Loading databases…" compact className="px-3 py-4" />
        ) : noBookmarks ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Star size={18} className="text-slate-700" />
            <p className="text-xs text-muted">No bookmarks yet.<br />Hover a table and click ★ to add one.</p>
          </div>
        ) : (
          visibleDbs.map(({ db, tbls }) => {
            const isOpen = expandedDbs.has(db)
            const tablesLoading = loadingTables.has(`${sessionId}/${db}`)

            return (
              <div key={db}>
                {/* Announced outside the toggle button so the button keeps its
                    schema-only accessible name while the table list loads. */}
                {tablesLoading && (
                  <LoadingState label={`Loading tables for ${db}…`} compact className="sr-only" />
                )}
                <div className="group flex items-center hover:bg-surface-800">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-slate-300"
                    onClick={() => toggleDb(db)}
                    onContextMenu={e => handleTableContext(e, db)}
                    title={db}
                  >
                    {tablesLoading
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
                    className="lagun-hit-target mr-1 rounded text-muted opacity-0 transition-opacity hover:text-brand-400 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 group-hover:opacity-100"
                  >
                    <Terminal size={10} />
                  </button>
                </div>

                <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                <AnimatePresence initial={false}>
                {tbls.map(tbl => {
                  const starred = isBookmarked(db, tbl.name)
                  return (
                    <m.div key={tbl.name} layout="position" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: surfaceTransition }} exit={{ opacity: 0, x: -8, transition: exitTransition }} className="group flex items-center hover:bg-surface-800">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-7 pr-2 text-slate-400 hover:text-slate-200"
                        onClick={() => openTableTab(sessionId, db, tbl.name)}
                        onContextMenu={e => handleTableContext(e, db, tbl.name)}
                        title={`${db}.${tbl.name}`}
                      >
                        <Table2 size={11} className="flex-shrink-0 text-muted" />
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
                        className={`mr-1 rounded p-1 transition-colors hover:text-yellow-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${starred ? 'text-yellow-400' : 'text-muted opacity-0 focus:opacity-100 group-hover:opacity-100'}`}
                      >
                        <Star size={10} fill={starred ? 'currentColor' : 'none'} />
                      </m.button>
                    </m.div>
                  )
                })}
                </AnimatePresence>
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
            <>
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
                onClick={() => { setCreateTableTarget({ db: contextMenu.db }); closeMenu() }}
              >
                <Plus size={12} /> Create Table
              </button>
            </>
          )}
        </m.div>
      )}
      </AnimatePresence>

      <Suspense fallback={null}>
        <CreateTableDialog
          open={!!createTableTarget}
          onClose={() => setCreateTableTarget(null)}
          sessionId={sessionId}
          database={createTableTarget?.db ?? ''}
          onCreated={refresh}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ImportDialog
          open={!!importTarget}
          onClose={() => setImportTarget(null)}
          sessionId={sessionId}
          database={importTarget?.db ?? ''}
          table={importTarget?.table}
        />
      </Suspense>
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
