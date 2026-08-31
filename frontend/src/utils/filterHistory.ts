// Per-table WHERE filter history for the data tab filter bar (HeidiSQL-style
// recent-filter dropdown). Stored in localStorage so history survives restarts.

const KEY = 'lagun-filter-history'
export const FILTER_HISTORY_LIMIT = 10

type HistoryMap = Record<string, Record<string, string[]>>

function readMap(): HistoryMap {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as HistoryMap) : {}
  } catch {
    return {}
  }
}

export function loadFilterHistory(database: string | undefined, table: string | undefined): string[] {
  if (!database || !table) return []
  return readMap()[database]?.[table] ?? []
}

/**
 * Record an applied filter at the front of the table's history (deduped,
 * capped at FILTER_HISTORY_LIMIT). Returns the updated list; best-effort
 * persistence — storage failures degrade to in-session history.
 */
export function recordFilterHistory(database: string | undefined, table: string | undefined, filter: string): string[] {
  if (!database || !table) return []
  const value = filter.trim()
  if (!value) return loadFilterHistory(database, table)
  const map = readMap()
  const previous = map[database]?.[table] ?? []
  const next = [value, ...previous.filter(f => f !== value)].slice(0, FILTER_HISTORY_LIMIT)
  map[database] = { ...(map[database] ?? {}), [table]: next }
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // Quota or storage unavailable — keep the in-memory list.
  }
  return next
}
