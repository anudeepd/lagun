import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Activity, ArrowLeft, CircleStop, Database, PanelsTopLeft, RefreshCw, Shield, Terminal, UserRound, Users, X } from 'lucide-react'
import * as m from 'motion/react-m'
import { AnimatePresence } from 'motion/react'
import { api } from '../../api/client'
import type { AdminActivityEvent, AdminActivityFilters, AdminConnection, AdminOverview, AdminPresence, AdminQuery, AdminRetention, AdminUser } from '../../types'
import ConfirmDialog from '../ui/ConfirmDialog'
import { surfaceTransition } from '../../motion/tokens'

type View = 'overview' | 'connections' | 'activity' | 'retention' | 'live' | 'users'
type AdminError = Error & { status?: number }
const DEFAULT_RETENTION_DAYS = 30
const REFRESH_INTERVAL_MS = 15_000
const NOTICE_TIMEOUT_MS = 5_000
const LIVE_QUERY_COLLAPSE_THRESHOLD = 240
const LIVE_SESSION_COLLAPSE_THRESHOLD = 4

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatDuration(value: number): string {
  return value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`
}


function emptyOverview(): AdminOverview {
  return {
    connection_count: 0,
    managed_connection_count: 0,
    private_connection_count: 0,
    audit_event_count: 0,
    audit_user_count: 0,
    live_user_count: 0,
    active_query_count: 0,
    window_hours: 24,
    observed_at: 0,
  }
}

function requestError(cause: unknown): AdminError {
  return cause instanceof Error ? cause as AdminError : new Error('Admin data unavailable.')
}

export default function AdminConsole({ onClose }: { onClose?: () => void }) {
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<AdminOverview>(emptyOverview)
  const [connections, setConnections] = useState<AdminConnection[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [userPolicyFingerprint, setUserPolicyFingerprint] = useState('')
  const [activity, setActivity] = useState<AdminActivityEvent[]>([])
  const [queries, setQueries] = useState<AdminQuery[]>([])
  const [presence, setPresence] = useState<AdminPresence[]>([])
  const [activityFilters, setActivityFilters] = useState<AdminActivityFilters>({})
  const [retention, setRetention] = useState<AdminRetention | null>(null)
  const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AdminError | null>(null)
  const [notice, setNotice] = useState('')
  const [lastUpdated, setLastUpdated] = useState(0)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [confirmRemoveUser, setConfirmRemoveUser] = useState<string | null>(null)
  const [userAction, setUserAction] = useState<string | null>(null)
  const refreshGeneration = useRef(0)
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [notice])
  const filtersRef = useRef<AdminActivityFilters>({})

  const refresh = useCallback(async (filters: AdminActivityFilters = filtersRef.current) => {
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError(null)
    try {
      const [overviewData, connectionData, userData, activityData, retentionData, queryData, presenceData] = await Promise.all([
        api.getAdminOverview(),
        api.getAdminConnections(),
        api.getAdminUsers(),
        api.getAdminActivity(filters),
        api.getAdminRetention(retentionDays),
        api.getAdminQueries(),
        api.getAdminPresence(),
      ])
      if (generation !== refreshGeneration.current) return
      setOverview(overviewData)
      setConnections(connectionData.items)
      setUsers(userData.items)
      setUserPolicyFingerprint(userData.fingerprint)
      setActivity(activityData.items)
      setRetention(retentionData)
      setQueries(queryData.items)
      setPresence(presenceData.items)
      setLastUpdated(Date.now())
    } catch (cause) {
      if (generation === refreshGeneration.current) setError(requestError(cause))
    } finally {
      if (generation === refreshGeneration.current) setLoading(false)
    }
  }, [retentionDays])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [refresh])

  const applyActivityFilters = (filters: AdminActivityFilters) => {
    filtersRef.current = filters
    setActivityFilters(filters)
    void refresh(filters)
  }

  const purge = async () => {
    setConfirmPurge(false)
    setNotice('')
    setError(null)
    try {
      const result = await api.purgeAdminRetention(retentionDays)
      setNotice(`Purged ${result.deleted} audit event${result.deleted === 1 ? '' : 's'}.`)
      await refresh()
    } catch (cause) {
      setError(requestError(cause))
    }
  }

  const addUser = async (username: string) => {
    setUserAction(username)
    setNotice('')
    setError(null)
    try {
      await api.addAdminUser(username, userPolicyFingerprint)
      setNotice(`Added ${username} to LDAP access policy.`)
      await refresh()
    } catch (cause) {
      setError(requestError(cause))
    } finally {
      setUserAction(null)
    }
  }

  const removeUser = async (username: string) => {
    setConfirmRemoveUser(null)
    setUserAction(username)
    setNotice('')
    setError(null)
    try {
      const result = await api.removeAdminUser(username, userPolicyFingerprint)
      setNotice(`Removed ${username} from LDAP access policy${result.revoked_sessions ? ` and revoked ${result.revoked_sessions} session${result.revoked_sessions === 1 ? '' : 's'}` : ''}.`)
      await refresh()
    } catch (cause) {
      setError(requestError(cause))
    } finally {
      setUserAction(null)
    }
  }

  const views: Array<[View, typeof Database, string]> = [
    ['overview', Database, 'Overview'],
    ['live', PanelsTopLeft, `Live workspace (${overview.live_user_count})`],
    ['connections', Database, `Connections (${overview.connection_count})`],
    ['users', UserRound, `Users (${users.length})`],
    ['activity', Activity, 'Query & API audit'],
    ['retention', CircleStop, 'Retention'],
  ]

  if (error && !lastUpdated) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-950 p-6 text-slate-200">
        <section className="w-full max-w-md rounded-lg border border-surface-800 bg-surface-900 p-6 text-center" aria-labelledby="admin-access-title">
          <Shield className="mx-auto mb-3 h-7 w-7 text-brand-400" />
          <h1 id="admin-access-title" className="text-base font-semibold">Admin access required</h1>
          <p className="mt-2 whitespace-pre-line text-sm text-slate-500">{error.message}</p>
          <a className="mt-5 inline-flex min-h-10 items-center rounded-md bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" href={`/_auth/login?next=${encodeURIComponent('/admin')}`}>Authenticate</a>
        </section>
      </div>
    )
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={surfaceTransition}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-surface-950 text-slate-200"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-surface-800 bg-surface-900 px-4 sm:px-5">
        {onClose && (
          <button type="button" onClick={onClose} className="lagun-icon-button rounded-md p-1.5 text-slate-500 hover:bg-surface-800 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Back to workspace">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <Shield className="h-4 w-4 text-brand-400" />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Admin console</h1>
          <p className="hidden text-[11px] text-slate-500 sm:block">Connection inventory, live workspaces, and query audit</p>
        </div>
        <span className="hidden text-[11px] text-slate-500 sm:inline" aria-live="polite">
          {lastUpdated ? `Updated ${age(lastUpdated / 1000)}` : 'Loading'}
        </span>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="lagun-interactive flex min-h-9 items-center gap-1.5 rounded-md border border-surface-700 px-2.5 py-1.5 text-xs text-slate-400 hover:bg-surface-800 hover:text-slate-200 disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 border-r border-surface-800 bg-surface-900 p-3 sm:block" aria-label="Admin views">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Control plane</p>
          {views.map(([key, Icon, label]) => (
            <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)} className={`lagun-interactive mb-1 flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500 hover:bg-surface-800 hover:text-slate-300'}`}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
          <div className="mt-6 rounded-md border border-surface-800 bg-surface-950/60 p-3 text-[11px] leading-relaxed text-slate-600">LDAP and connections.yaml remain source of truth for access policy. This console never reveals stored database passwords.</div>
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6" aria-live="polite">
          <div className="mx-auto max-w-6xl">
            <div className="mb-4 flex gap-1 overflow-x-auto sm:hidden" role="tablist" aria-label="Admin views">
              {views.map(([key, , label]) => (
                <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`min-h-10 whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-colors ${view === key ? 'bg-brand-500/10 text-brand-300' : 'text-slate-500 hover:bg-surface-800'}`}>{label}</button>
              ))}
            </div>
            {notice && <div className="mb-3 flex items-center gap-2 rounded-md border border-green-900/50 bg-green-950/30 px-3 py-2 text-xs text-green-300" role="status"><Shield className="h-3.5 w-3.5" /> {notice}</div>}
            {error && <div className="mb-3 flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300" role="alert"><X className="h-3.5 w-3.5" /> {error.message}</div>}
            <AnimatePresence mode="wait" initial={false}>
              <m.div key={view} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={surfaceTransition}>
                {view === 'overview' && <OverviewPanel overview={overview} connections={connections} onViewConnections={() => setView('connections')} onViewLive={() => setView('live')} />}
                {view === 'live' && <LiveWorkspacePanel presence={presence} queries={queries} connections={connections} />}
                {view === 'connections' && <ConnectionsPanel connections={connections} presence={presence} />}
                {view === 'users' && <UsersPanel users={users} onAdd={addUser} onRequestRemove={setConfirmRemoveUser} busyUsername={userAction} />}
                {view === 'activity' && <ActivityPanel events={activity} filters={activityFilters} onApply={applyActivityFilters} />}
                {view === 'retention' && <RetentionPanel retention={retention} days={retentionDays} onDaysChange={setRetentionDays} onRefresh={() => void refresh()} onPurge={() => setConfirmPurge(true)} />}
              </m.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
      <ConfirmDialog
        open={confirmPurge}
        title="Purge audit history?"
        message={`Permanently delete audit events older than ${retentionDays} days. This cannot be undone.`}
        confirmLabel="Purge history"
        danger
        onConfirm={() => void purge()}
        onClose={() => setConfirmPurge(false)}
      />
      <ConfirmDialog
        open={Boolean(confirmRemoveUser)}
        title="Remove LDAP user?"
        message={confirmRemoveUser ? `Remove ${confirmRemoveUser} from future Lagun logins and revoke their active sessions.` : ''}
        confirmLabel="Remove user"
        danger
        onConfirm={() => { if (confirmRemoveUser) void removeUser(confirmRemoveUser) }}
        onClose={() => setConfirmRemoveUser(null)}
      />
    </m.div>
  )
}

function UsersPanel({
  users,
  onAdd,
  onRequestRemove,
  busyUsername,
}: {
  users: AdminUser[]
  onAdd: (username: string) => Promise<void>
  onRequestRemove: (username: string) => void
  busyUsername: string | null
}) {
  const [username, setUsername] = useState('')
  const allowedCount = users.filter(user => user.policy_state === 'allowed').length

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = username.trim()
    if (!value || busyUsername) return
    await onAdd(value)
    setUsername('')
  }

  return (
    <section aria-labelledby="users-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Access policy / live</p>
          <h2 id="users-title" className="text-xl font-semibold tracking-tight text-slate-100">Users &amp; policy</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">Manage LDAP users allowed to sign in. Changes are written atomically and apply without restarting Lagun.</p>
        </div>
        <span className="rounded-full border border-brand-800/60 bg-brand-950/20 px-2.5 py-1 text-[11px] font-mono text-brand-300">{allowedCount} allowed</span>
      </div>

      <form onSubmit={submit} className="mb-4 rounded-lg border border-surface-800 bg-surface-900 p-4" aria-label="Add LDAP user">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs text-slate-400">
            LDAP username
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="e.g. analyst"
              autoComplete="off"
              className="mt-1.5 min-h-10 w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-700 focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <button type="submit" disabled={!username.trim() || Boolean(busyUsername)} className="min-h-10 rounded-md bg-brand-600 px-3 py-2 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50">
            {busyUsername ? 'Applying…' : 'Allow user'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">User must also exist in LDAP. Existing sessions are not changed when access is added.</p>
      </form>

      <div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900">
        <table className="w-full min-w-[650px] text-left text-xs">
          <caption className="sr-only">LDAP access policy and live workspace activity</caption>
          <thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600">
            <tr>
              <th scope="col" className="px-4 py-2">User</th>
              <th scope="col" className="px-4 py-2">Policy</th>
              <th scope="col" className="px-4 py-2">Active clients</th>
              <th scope="col" className="px-4 py-2">Open tabs</th>
              <th scope="col" className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.username} className="border-b border-surface-800/70 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-200">{user.username}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-[10px] ${user.policy_state === 'allowed' ? 'bg-green-950/40 text-green-300' : 'bg-slate-800 text-slate-500'}`}>
                    {user.policy_state === 'allowed' ? 'Allowed' : 'Observed only'}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono tabular-nums text-slate-400">{user.active_clients}</td>
                <td className="px-4 py-3 font-mono tabular-nums text-slate-400">{user.active_tabs}</td>
                <td className="px-4 py-3 text-right">
                  {user.policy_state === 'allowed' && (
                    <button type="button" disabled={Boolean(busyUsername)} onClick={() => onRequestRemove(user.username)} className="min-h-8 rounded border border-red-900/60 px-2.5 py-1.5 text-[11px] text-red-300 hover:bg-red-950/40 disabled:opacity-50">
                      {busyUsername === user.username ? 'Applying…' : 'Remove'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-xs text-slate-600">No users in LDAP access policy.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}


function OverviewPanel({ overview, connections, onViewConnections, onViewLive }: { overview: AdminOverview; connections: AdminConnection[]; onViewConnections: () => void; onViewLive: () => void }) {
  const metrics = [
    ['Connection profiles', overview.connection_count, 'All saved profiles'],
    ['Managed connections', overview.managed_connection_count, 'From connections.yaml'],
    ['Private connections', overview.private_connection_count, 'Owner-bound profiles'],
    ['Live users', overview.live_user_count, 'Workspace heartbeats'],
    ['Active queries', overview.active_query_count, 'Running or queued now'],
    ['Audit events', overview.audit_event_count, `Last ${overview.window_hours} hours`],
    ['Observed users', overview.audit_user_count, `Active in last ${overview.window_hours} hours`],
  ] as const
  return (
    <section aria-labelledby="overview-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Operations</p>
          <h2 id="overview-title" className="text-xl font-semibold tracking-tight text-slate-100">Workspace overview</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">See which connection profiles exist, who has workspaces open, and which queries are running now.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onViewLive} className="min-h-9 rounded border border-brand-800/60 px-2.5 py-1.5 text-xs text-brand-300 hover:bg-brand-950/40">Open live view</button>
          <span className="rounded-full border border-surface-700 px-2.5 py-1 text-[11px] font-mono text-slate-500">LDAP protected</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value, hint]) => (
          <article key={label} className="flex min-h-28 flex-col rounded-lg border border-surface-800 bg-gradient-to-br from-surface-800/90 to-surface-900 p-4 shadow-lg shadow-black/10">
            <span className="text-xs text-slate-500">{label}</span>
            <strong className="mt-auto font-mono text-2xl font-semibold tabular-nums tracking-tight text-slate-100">{value}</strong>
            <small className="mt-2 text-[11px] leading-snug text-slate-600">{hint}</small>
          </article>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-surface-800 bg-surface-900">
        <div className="flex items-center justify-between gap-3 border-b border-surface-800 px-4 py-3">
          <div><h3 className="text-sm font-semibold">Connection posture</h3><p className="mt-1 text-xs text-slate-600">Managed profiles are read-only here; edit connections.yaml and restart Lagun.</p></div>
          <button type="button" onClick={onViewConnections} className="min-h-9 shrink-0 rounded border border-surface-700 px-2.5 py-1.5 text-xs text-brand-300 hover:bg-surface-800">View all</button>
        </div>
        <table className="w-full min-w-[620px] text-left text-xs">
          <caption className="sr-only">Connection posture preview</caption>
          <thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-4 py-2">Connection</th><th scope="col" className="px-4 py-2">Type</th><th scope="col" className="px-4 py-2">Access</th><th scope="col" className="px-4 py-2">Scope</th></tr></thead>
          <tbody>
            {connections.slice(0, 5).map(connection => <ConnectionRow key={connection.id} connection={connection} />)}
            {connections.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-600">No saved connections.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ConnectionRow({ connection }: { connection: AdminConnection }) {
  return (
    <tr className="border-b border-surface-800/70 last:border-0">
      <td className="px-4 py-3"><div className="font-medium text-slate-200">{connection.name}</div><div className="mt-1 font-mono text-[10px] text-slate-600">{connection.host}:{connection.port}</div></td>
      <td className="px-4 py-3">{connection.managed ? <span className="text-brand-300">Managed</span> : <span className="text-slate-400">Private</span>}</td>

      <td className="px-4 py-3 text-slate-400">{connection.managed ? `${connection.shared_user_count} user${connection.shared_user_count === 1 ? '' : 's'}` : connection.owner_username || 'local user'}</td>
      <td className="px-4 py-3 text-slate-500">{connection.selected_databases.length ? `${connection.selected_databases.length} database${connection.selected_databases.length === 1 ? '' : 's'}` : 'All databases'}</td>
    </tr>
  )
}
function LiveWorkspacePanel({ presence, queries, connections }: { presence: AdminPresence[]; queries: AdminQuery[]; connections: AdminConnection[] }) {
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const liveUsers = Array.from(new Set([...presence.map(item => item.username), ...queries.map(item => item.username)])).sort()
  const activeUser = selectedUser && liveUsers.includes(selectedUser) ? selectedUser : liveUsers[0] || null
  const selectedPresence = activeUser ? presence.filter(item => item.username === activeUser) : []
  const selectedQueries = activeUser ? queries.filter(item => item.username === activeUser) : []
  const openTabs = presence.reduce((count, item) => count + item.tabs.length, 0)
  const sessionTabs = new Map<string, AdminPresence['tabs']>()

  selectedPresence.forEach(item => {
    item.tabs.forEach(tab => {
      const tabs = sessionTabs.get(tab.session_id) || []
      tabs.push(tab)
      sessionTabs.set(tab.session_id, tabs)
    })
  })

  useEffect(() => {
    if (selectedUser && !liveUsers.includes(selectedUser)) setSelectedUser(null)
  }, [liveUsers, selectedUser])

  return (
    <section aria-labelledby="live-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Realtime / 45s TTL</p>
          <h2 id="live-title" className="text-xl font-semibold tracking-tight text-slate-100">Live workspace</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">Choose a user to inspect connected sessions, open tabs, and queries running now.</p>
        </div>
        <span className="rounded-full border border-green-900/60 bg-green-950/20 px-2.5 py-1 text-[11px] font-mono text-green-300">{presence.length} client{presence.length === 1 ? '' : 's'} online</span>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <LiveMetric icon={Users} label="Workspace users" value={liveUsers.length} />
        <LiveMetric icon={PanelsTopLeft} label="Open tabs" value={openTabs} />
        <LiveMetric icon={Terminal} label="Active queries" value={queries.length} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[16rem_1fr]">
        <section className="rounded-lg border border-surface-800 bg-surface-900" aria-labelledby="users-title">
          <div className="border-b border-surface-800 px-4 py-3">
            <h3 id="users-title" className="text-sm font-semibold">Users online</h3>
            <p className="mt-1 text-xs text-slate-600">Select a user for workspace details.</p>
          </div>
          <div className="divide-y divide-surface-800/70">
            {liveUsers.map(username => {
              const userPresence = presence.filter(item => item.username === username)
              const userTabs = userPresence.reduce((count, item) => count + item.tabs.length, 0)
              const userSessions = new Set(userPresence.flatMap(item => item.tabs.map(tab => tab.session_id))).size
              const userQueries = queries.filter(item => item.username === username).length
              return (
                <button
                  key={username}
                  type="button"
                  aria-pressed={activeUser === username}
                  onClick={() => setSelectedUser(username)}
                  className={`w-full px-4 py-3 text-left transition-colors ${activeUser === username ? 'bg-brand-500/10 text-brand-200' : 'text-slate-400 hover:bg-surface-800/60 hover:text-slate-200'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="truncate text-sm">{username}</strong>
                    {userQueries > 0 && <span className="rounded-full bg-amber-950/50 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">{userQueries} running</span>}
                  </span>
                  <span className="mt-1 block text-[10px] text-slate-600">{userSessions} session{userSessions === 1 ? '' : 's'} · {userTabs} tab{userTabs === 1 ? '' : 's'}</span>
                </button>
              )
            })}
            {liveUsers.length === 0 && <p className="px-4 py-10 text-center text-xs text-slate-600">No active users.</p>}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-surface-800 bg-surface-900" aria-labelledby="presence-title">
            <div className="border-b border-surface-800 px-4 py-3">
              <h3 id="presence-title" className="text-sm font-semibold">{activeUser ? `${activeUser}'s sessions and tabs` : 'Sessions and tabs'}</h3>
              <p className="mt-1 text-xs text-slate-600">Connected session identity and current browser tabs.</p>
            </div>
            <div className="divide-y divide-surface-800/70">
              {[...sessionTabs.entries()].map(([sessionId, tabs]) => {
                const connection = connections.find(item => item.id === sessionId)
                return (
                  <details key={sessionId} open={tabs.length <= LIVE_SESSION_COLLAPSE_THRESHOLD} className="border-b border-surface-800/70 last:border-0">
                    <summary className="cursor-pointer list-none px-4 py-3 hover:bg-surface-800/40 [&::-webkit-details-marker]:hidden">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <strong className="block truncate text-sm text-slate-200">{connection?.name || sessionId}</strong>
                          <p className="mt-1 truncate font-mono text-[10px] text-slate-600">{connection ? `${connection.host}:${connection.port} · ${connection.username}` : sessionId}</p>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-slate-600">{tabs.length} tab{tabs.length === 1 ? '' : 's'}</span>
                      </div>
                    </summary>
                    <ul className="grid gap-1.5 px-4 pb-3">
                      {tabs.map(tab => <li key={`${sessionId}-${tab.id}`} className="rounded border border-surface-800 bg-surface-950/50 px-2.5 py-2 text-[11px] text-slate-400"><div className="flex items-center gap-1.5"><PanelsTopLeft className="h-3 w-3 text-slate-600" /><span className="truncate">{tab.label}</span>{selectedPresence.some(item => item.active_tab_id === tab.id) && <span className="ml-auto text-[9px] uppercase tracking-wider text-brand-300">active</span>}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600">{tab.database || connection?.default_db || 'No database'}{tab.table ? ` · ${tab.table}` : ''}</div></li>)}
                    </ul>
                  </details>
                )
              })}
              {activeUser && sessionTabs.size === 0 && <p className="px-4 py-10 text-center text-xs text-slate-600">No open tabs currently reported.</p>}
              {!activeUser && <p className="px-4 py-10 text-center text-xs text-slate-600">Select a user to inspect their workspace.</p>}
            </div>
          </section>

          <section className="rounded-lg border border-surface-800 bg-surface-900" aria-labelledby="queries-title">
            <div className="border-b border-surface-800 px-4 py-3">
              <h3 id="queries-title" className="text-sm font-semibold">{activeUser ? `${activeUser}'s active queries` : 'Active queries'}</h3>
              <p className="mt-1 text-xs text-slate-600">Complete SQL is shown while it is running, including literals and multi-statement text.</p>
            </div>
            <div className="divide-y divide-surface-800/70">
              {selectedQueries.map(item => {
                const sql = item.sql || 'Waiting for query text'
                const isLargeQuery = sql.length > LIVE_QUERY_COLLAPSE_THRESHOLD
                return (
                  <article key={`${item.session_id}-${item.execution_id}`} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className={`h-2 w-2 rounded-full ${item.state === 'running' ? 'bg-amber-400' : 'bg-slate-500'}`} aria-hidden="true" /><span className="text-[10px] text-slate-600">{item.kind} · {item.state}</span></div><span className="shrink-0 font-mono text-[10px] text-slate-500">{formatDuration(item.elapsed_ms)}</span></div>
                    {isLargeQuery ? (
                      <>
                        <p className="mt-2 line-clamp-2 rounded bg-surface-950 p-2 font-mono text-[11px] leading-relaxed text-slate-500">{sql.slice(0, 200)}…</p>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] text-brand-300 hover:text-brand-200">Show full SQL ({sql.length} characters)</summary>
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-950 p-2 font-mono text-[11px] leading-relaxed text-slate-400">{sql}</pre>
                        </details>
                      </>
                    ) : (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-950 p-2 font-mono text-[11px] leading-relaxed text-slate-400">{sql}</pre>
                    )}
                    <p className="mt-1 truncate text-[10px] text-slate-600">{item.session_name || item.session_id}{item.database ? ` · ${item.database}` : ''}{item.tab_id ? ` · tab ${item.tab_id}` : ''}</p>
                  </article>
                )
              })}
              {activeUser && selectedQueries.length === 0 && <p className="px-4 py-10 text-center text-xs text-slate-600">No active queries for this user.</p>}
              {!activeUser && <p className="px-4 py-10 text-center text-xs text-slate-600">Select a user to inspect running queries.</p>}
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}

function LiveMetric({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  return <article className="flex items-center gap-3 rounded-lg border border-surface-800 bg-surface-900 p-4"><Icon className="h-4 w-4 text-brand-400" /><div><div className="font-mono text-xl font-semibold tabular-nums text-slate-100">{value}</div><div className="text-[11px] text-slate-600">{label}</div></div></article>
}

function ConnectionsPanel({ connections, presence }: { connections: AdminConnection[]; presence: AdminPresence[] }) {
  return (
    <section aria-labelledby="connections-title">
      <div className="mb-4"><p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Inventory</p><h2 id="connections-title" className="text-xl font-semibold tracking-tight">Connection inventory</h2><p className="mt-1 text-sm leading-relaxed text-slate-500">See saved session metadata and which users currently have tabs open. Matching hostnames are separated by connection name, database identity, and owner.</p></div>
      <div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900">
        <table className="w-full min-w-[1120px] text-left text-xs">
          <caption className="sr-only">Saved connection inventory and active users</caption>
          <thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">Connection</th><th scope="col" className="px-3 py-2">Owner / access</th><th scope="col" className="px-3 py-2">Database identity</th><th scope="col" className="px-3 py-2">Scope</th><th scope="col" className="px-3 py-2">Connected users / tabs</th><th scope="col" className="px-3 py-2">Updated</th></tr></thead>
          <tbody>
            {connections.map(connection => {
              const activeUsers = new Map<string, string[]>()
              presence.forEach(item => {
                const labels = item.tabs.filter(tab => tab.session_id === connection.id).map(tab => tab.label)
                if (labels.length) activeUsers.set(item.username, [...(activeUsers.get(item.username) || []), ...labels])
              })
              return (
                <tr key={connection.id} className="border-b border-surface-800/70 last:border-0">
                  <td className="px-3 py-3"><div className="font-medium text-slate-200">{connection.name}{connection.is_default && <span className="ml-2 rounded-full border border-brand-800/70 px-1.5 py-0.5 text-[9px] text-brand-300">default</span>}</div><div className="mt-1 font-mono text-[10px] text-slate-600">{connection.host}:{connection.port} {connection.ssl_enabled ? '· TLS' : ''}</div></td>
                  <td className="px-3 py-3"><div className={connection.managed ? 'text-brand-300' : 'text-slate-400'}>{connection.managed ? 'Managed profile' : 'Private profile'}</div><div className="mt-1 text-[11px] text-slate-600">{connection.managed ? `${connection.shared_user_count} allowed user${connection.shared_user_count === 1 ? '' : 's'}` : connection.owner_username || 'local user'}</div></td>
                  <td className="px-3 py-3 font-mono text-[11px] text-slate-400">{connection.username}</td>
                  <td className="px-3 py-3 text-slate-400">{connection.selected_databases.length ? connection.selected_databases.join(', ') : 'All non-system schemas'}</td>
                  <td className="px-3 py-3">{activeUsers.size ? <div className="grid gap-1.5">{[...activeUsers.entries()].map(([username, labels]) => <div key={username}><div className="font-medium text-slate-300">{username} <span className="font-mono text-[10px] text-slate-600">· {labels.length} tab{labels.length === 1 ? '' : 's'}</span></div><div className="truncate text-[10px] text-slate-600" title={labels.join(' · ')}>{labels.join(' · ')}</div></div>)}</div> : <span className="text-slate-600">No active users</span>}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-500">{formatDate(connection.updated_at)}</td>
                </tr>
              )
            })}
            {connections.length === 0 && <tr><td colSpan={6} className="px-3 py-12 text-center text-slate-600">No saved connections.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ActivityPanel({ events, filters, onApply }: { events: AdminActivityEvent[]; filters: AdminActivityFilters; onApply: (filters: AdminActivityFilters) => void }) {
  const [username, setUsername] = useState(filters.username || '')
  const [path, setPath] = useState(filters.path || '')
  const [since, setSince] = useState(filters.since || '')
  const [statusCode, setStatusCode] = useState(filters.statusCode ? String(filters.statusCode) : '')

  useEffect(() => {
    setUsername(filters.username || '')
    setPath(filters.path || '')
    setSince(filters.since || '')
    setStatusCode(filters.statusCode ? String(filters.statusCode) : '')
  }, [filters])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onApply({ username, path, since, statusCode: statusCode ? Number(statusCode) : undefined })
  }

  const clear = () => {
    setUsername('')
    setPath('')
    setSince('')
    setStatusCode('')
    onApply({})
  }

  return (
    <section aria-labelledby="activity-title">
      <div className="mb-4"><p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Audit trail</p><h2 id="activity-title" className="text-xl font-semibold tracking-tight">Query &amp; API audit</h2><p className="mt-1 text-sm leading-relaxed text-slate-500">See every request body exactly as received. Expand details to inspect complete query text and API payloads.</p></div>
      <form onSubmit={submit} className="mb-4 grid gap-2 rounded-lg border border-surface-800 bg-surface-900 p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_0.8fr_0.7fr_auto] lg:items-end">
        <FilterInput id="admin-activity-user" label="User" value={username} onChange={setUsername} placeholder="All users" />
        <FilterInput id="admin-activity-path" label="Path contains" value={path} onChange={setPath} placeholder="/sessions" />
        <FilterInput id="admin-activity-since" label="Since" value={since} onChange={setSince} type="date" />
        <FilterInput id="admin-activity-status" label="Status" value={statusCode} onChange={setStatusCode} placeholder="Any" inputMode="numeric" />
        <div className="flex gap-2"><button type="submit" className="min-h-10 rounded border border-brand-700/60 px-3 py-2 text-xs text-brand-300 hover:bg-brand-950/40">Apply</button><button type="button" onClick={clear} className="min-h-10 rounded border border-surface-700 px-3 py-2 text-xs text-slate-400 hover:bg-surface-800 hover:text-slate-200">Clear</button></div>
      </form>
      <div className="overflow-x-auto rounded-lg border border-surface-800 bg-surface-900">
        <table className="w-full min-w-[980px] text-left text-xs">
          <caption className="sr-only">Lagun API audit events</caption>
          <thead className="border-b border-surface-800 text-[10px] uppercase tracking-wider text-slate-600"><tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Actor</th><th scope="col" className="px-3 py-2">Request</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2 text-right">Duration</th></tr></thead>
          <tbody>
            {events.map(event => <tr key={`${event.occurred_at}-${event.path}-${event.duration_ms}`} className="border-b border-surface-800/70 last:border-0"><td className="whitespace-nowrap px-3 py-3 text-slate-500">{formatDate(event.occurred_at)}</td><td className="px-3 py-3 font-medium text-slate-200">{event.username}</td><td className="px-3 py-3 align-top"><div className="font-mono text-[11px] text-slate-300">{event.method} {event.path}</div>{event.details && <details className="mt-2"><summary className="cursor-pointer text-[11px] text-brand-300">Show full request details</summary><pre className="mt-2 max-h-[70vh] max-w-[min(70vw,64rem)] overflow-auto whitespace-pre rounded bg-surface-950 p-2 font-mono text-[10px] leading-relaxed text-slate-400">{event.details}</pre></details>}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${event.status_code >= 400 ? 'bg-red-950/50 text-red-300' : 'bg-emerald-950/40 text-emerald-300'}`}>{event.status_code}</span></td><td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[10px] text-slate-500">{event.duration_ms} ms</td></tr>)}
            {events.length === 0 && <tr><td colSpan={5} className="px-3 py-12 text-center text-slate-600">No matching audit events.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function FilterInput({ id, label, value, onChange, placeholder, type = 'search', inputMode }: { id: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: 'search' | 'date'; inputMode?: 'numeric' }) {
  return <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-slate-400">{label}<input id={id} type={type} inputMode={inputMode} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="min-h-10 rounded border border-surface-700 bg-surface-950 px-2.5 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30" /></label>
}

function RetentionPanel({ retention, days, onDaysChange, onRefresh, onPurge }: { retention: AdminRetention | null; days: number; onDaysChange: (days: number) => void; onRefresh: () => void; onPurge: () => void }) {
  return (
    <section aria-labelledby="retention-title" className="max-w-2xl">
      <div className="mb-4"><p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-400">Lifecycle</p><h2 id="retention-title" className="text-xl font-semibold tracking-tight">Audit retention</h2><p className="mt-1 text-sm leading-relaxed text-slate-500">Remove old API audit events from Lagun's local SQLite store. Connection profiles and encrypted credentials are not affected.</p></div>
      <div className="rounded-lg border border-surface-800 bg-surface-900 p-4 sm:p-5">
        <label htmlFor="admin-retention-days" className="text-xs font-medium text-slate-300">Delete events older than</label>
        <div className="mt-2 flex flex-wrap items-center gap-2"><input id="admin-retention-days" type="number" min={retention?.minimum_age_days ?? 7} max={3650} value={days} onChange={event => onDaysChange(Math.max(retention?.minimum_age_days ?? 7, Math.min(3650, Number(event.target.value) || retention?.minimum_age_days || 7)))} className="min-h-10 w-28 rounded border border-surface-700 bg-surface-950 px-2.5 py-2 text-sm text-slate-200 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30" /><span className="text-xs text-slate-500">days</span><button type="button" onClick={onRefresh} className="ml-auto min-h-10 rounded border border-surface-700 px-3 py-2 text-xs text-slate-400 hover:bg-surface-800 hover:text-slate-200">Check eligibility</button></div>
        <dl className="mt-5 grid gap-3 border-t border-surface-800 pt-4 text-xs sm:grid-cols-3"><div><dt className="text-slate-600">Eligible events</dt><dd className="mt-1 font-mono text-lg text-slate-200">{retention?.eligible_count ?? '—'}</dd></div><div><dt className="text-slate-600">Minimum age</dt><dd className="mt-1 font-mono text-lg text-slate-200">{retention?.minimum_age_days ?? 7} days</dd></div><div><dt className="text-slate-600">Scope</dt><dd className="mt-1 text-slate-400">Audit events only</dd></div></dl>
        <button type="button" disabled={!retention?.eligible_count} onClick={onPurge} className="mt-5 min-h-10 rounded border border-red-900/60 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40">Review purge</button>
      </div>
    </section>
  )
}
