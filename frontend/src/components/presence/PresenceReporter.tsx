import { useEffect, useMemo } from 'react'
import { api } from '../../api/client'
import { useTabStore } from '../../store/tabStore'
import type { PresenceUpdate } from '../../types'

const CLIENT_ID_KEY = 'lagun-presence-client-id'
const MAX_GLOBAL_SEARCH_LENGTH = 1000
const MAX_WHERE_FILTER_LENGTH = 32_000

function presenceText(value: string | undefined, maxLength: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
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
    tabs: tabs.map(tab => ({
      id: tab.id,
      type: tab.type,
      label: tab.label,
      session_id: tab.sessionId,
      database: tab.database ?? null,
      table: tab.table ?? null,
      ...(tab.type === 'table' ? {
        view: tab.dataState?.view ?? 'schema',
        global_search: presenceText(tab.dataState?.globalSearch, MAX_GLOBAL_SEARCH_LENGTH),
        where_filter: presenceText(tab.dataState?.appliedWhere, MAX_WHERE_FILTER_LENGTH),
        row_limit: tab.dataState?.limit ?? 1000,
      } : {}),
    })),
  }), [activeTabId, clientId, tabs])

  useEffect(() => {
    let cancelled = false
    const send = () => {
      if (!cancelled) void api.reportPresence(payload).catch(() => undefined)
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
