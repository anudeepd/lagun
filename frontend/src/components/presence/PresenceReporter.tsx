import { useEffect, useMemo, useRef } from 'react'
import { api } from '../../api/client'
import { useTabStore } from '../../store/tabStore'
import { showToast } from '../../utils/toast'
import type { PresenceUpdate } from '../../types'

const CLIENT_ID_KEY = 'lagun-presence-client-id'
const MAX_GLOBAL_SEARCH_LENGTH = 1000
const MAX_WHERE_FILTER_LENGTH = 32_000
// Mirrors lagun/api/presence.py. A single over-long field — or more than 100
// open tabs — makes the whole POST a 422, which silently removed the user from
// the admin live view while the heartbeat kept retrying.
const MAX_LABEL_LENGTH = 200
const MAX_DATABASE_LENGTH = 128
const MAX_TABLE_LENGTH = 128
const MAX_VIEW_LENGTH = 32
const MAX_TABS = 100

// Generic only so the tab's literal `view` union survives the clamp; the
// max lengths are all far longer than any literal that reaches them.
function presenceText<T extends string>(value: T | undefined, maxLength: number): T | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return (trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed) as T
}


function getClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const value = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(CLIENT_ID_KEY, value)
    return value
  } catch {
    return `client-${Date.now()}`
  }
}

export default function PresenceReporter() {
  const tabs = useTabStore(s => s.tabs)
  const activeTabId = useTabStore(s => s.activeTabId)
  const clientId = useMemo(getClientId, [])
  const payload = useMemo<PresenceUpdate>(() => ({
    client_id: clientId,
    active_tab_id: activeTabId,
    tabs: tabs.slice(0, MAX_TABS).map(tab => ({
      id: tab.id,
      type: tab.type,
      // `label` is required by the API model, so `presenceText`'s null (empty
      // after trimming) must fall back to an empty string, not `null`.
      label: presenceText(tab.label, MAX_LABEL_LENGTH) ?? '',
      session_id: tab.sessionId,
      database: presenceText(tab.database, MAX_DATABASE_LENGTH),
      table: presenceText(tab.table, MAX_TABLE_LENGTH),
      ...(tab.type === 'table' ? {
        view: presenceText(tab.dataState?.view ?? 'schema', MAX_VIEW_LENGTH) ?? 'schema',
        global_search: presenceText(tab.dataState?.globalSearch, MAX_GLOBAL_SEARCH_LENGTH),
        where_filter: presenceText(tab.dataState?.appliedWhere, MAX_WHERE_FILTER_LENGTH),
        row_limit: tab.dataState?.limit ?? 1000,
      } : {}),
    })),
  }), [activeTabId, clientId, tabs])

  // Surface the first failure only, for the lifetime of this reporter: the
  // heartbeat retries every 15 s and a payload change restarts it, so a
  // persistent outage must not produce a toast per attempt.
  const failureReportedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const send = () => {
      if (cancelled) return
      void api.reportPresence(payload).catch((error: unknown) => {
        if (failureReportedRef.current) return
        failureReportedRef.current = true
        showToast(
          `Could not publish presence: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
      })
    }
    const timer = window.setTimeout(send, 150)
    const heartbeat = window.setInterval(send, 15_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(heartbeat)
    }
  }, [payload])

  useEffect(() => () => {
    void api.deletePresence(clientId).catch(() => undefined)
  }, [clientId])

  return null
}
