import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Loader2, Database, RefreshCw } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import { useSessionStore } from '../../store/sessionStore'
import { api } from '../../api/client'
import type { Session } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
  session?: Session
}

const defaults = {
  name: '',
  host: 'localhost',
  port: '3306',
  username: 'root',
  password: '',
  default_db: '',
  query_limit: '100',
  ssl_enabled: false,
}

export default function SessionForm({ open, onClose, session }: Props) {
  const { createSession, updateSession, testSession } = useSessionStore()
  const [form, setForm] = useState(defaults)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [availableDbs, setAvailableDbs] = useState<string[]>([])
  const [selectedDbs, setSelectedDbs] = useState<string[]>([])
  const [fetchingDbs, setFetchingDbs] = useState(false)
  const [fetchDbError, setFetchDbError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (session) {
      setForm({
        name: session.name,
        host: session.host,
        port: String(session.port),
        username: session.username,
        password: '',  // never pre-fill password
        default_db: session.default_db ?? '',
        query_limit: String(session.query_limit),
        ssl_enabled: session.ssl_enabled,
      })
      setSelectedDbs(session.selected_databases ?? [])
    } else {
      setForm(defaults)
      setSelectedDbs([])
    }
    setError(null)
    setTestResult(null)
    setAvailableDbs([])
    setFetchDbError(null)
  }, [session, open])

  const set = (field: string, val: string | boolean) =>
    setForm(f => ({ ...f, [field]: val }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const data = {
        name: form.name,
        host: form.host,
        port: parseInt(form.port),
        username: form.username,
        // Only include password if the user actually typed one (empty = keep existing)
        ...(form.password ? { password: form.password } : {}),
        default_db: form.default_db || undefined,
        query_limit: parseInt(form.query_limit),
        ssl_enabled: form.ssl_enabled,
        selected_databases: selectedDbs,
      }
      if (session) {
        await updateSession(session.id, data)
      } else {
        await createSession({ ...data, password: form.password })
      }
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      let r
      if (session) {
        r = await testSession(session.id)
      } else {
        r = await api.probeConnection({
          host: form.host,
          port: parseInt(form.port),
          username: form.username,
          password: form.password,
          ssl_enabled: form.ssl_enabled,
        })
      }
      if (r.ok) {
        setTestResult({ ok: true, msg: `Connected! MySQL ${r.server_version} — ${r.latency_ms}ms` })
      } else {
        setTestResult({ ok: false, msg: r.error ?? 'Connection failed' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleFetchDbs = async () => {
    setFetchingDbs(true)
    setFetchDbError(null)
    try {
      let r
      if (session) {
        r = await testSession(session.id)
      } else {
        r = await api.probeConnection({
          host: form.host,
          port: parseInt(form.port),
          username: form.username,
          password: form.password,
          ssl_enabled: form.ssl_enabled,
        })
      }
      if (r.ok) {
        const dbs = r.databases ?? []
        setAvailableDbs(dbs)
        setSelectedDbs(prev => prev.filter(d => dbs.includes(d)))
      } else {
        setFetchDbError(r.error ?? 'Connection failed')
      }
    } catch (e) {
      setFetchDbError(String(e))
    } finally {
      setFetchingDbs(false)
    }
  }

  const toggleDb = (db: string) => {
    setSelectedDbs(prev =>
      prev.includes(db) ? prev.filter(d => d !== db) : [...prev, db]
    )
  }

  const toggleAll = () => {
    setSelectedDbs(prev => prev.length === availableDbs.length ? [] : [...availableDbs])
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={session ? 'Edit Connection' : 'New Connection'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 size={12} className="animate-spin" /> : null}
            Test
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            {session ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {testResult && (
          <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded ${testResult.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
            {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
            {testResult.msg}
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}

        <Input label="Connection Name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="My Database" />
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <Input label="Host" value={form.host} onChange={e => set('host', e.target.value)} placeholder="localhost" />
          </div>
          <Input label="Port" type="number" value={form.port} onChange={e => set('port', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input label="Username" value={form.username} onChange={e => set('username', e.target.value)} placeholder="root" />
          <Input label="Password" type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder={session ? '(unchanged)' : ''} />
        </div>
        <Input label="Default Database (optional)" value={form.default_db} onChange={e => set('default_db', e.target.value)} placeholder="my_db" />
        <Input label="Row Limit" type="number" value={form.query_limit} onChange={e => set('query_limit', e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={form.ssl_enabled as boolean} onChange={e => set('ssl_enabled', e.target.checked)} className="rounded" />
          Enable SSL
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Databases</span>
            <div className="flex items-center gap-2">
              {availableDbs.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-brand-400 hover:text-brand-300"
                >
                  {selectedDbs.length === availableDbs.length ? 'Deselect all' : 'Select all'}
                </button>
              )}
              <button
                type="button"
                onClick={handleFetchDbs}
                disabled={fetchingDbs}
                title="Fetch databases from server"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-surface-700 hover:bg-surface-600 text-slate-300 disabled:opacity-50"
              >
                {fetchingDbs
                  ? <Loader2 size={11} className="animate-spin" />
                  : <RefreshCw size={11} />}
                Fetch
              </button>
            </div>
          </div>

          {fetchDbError && (
            <p className="text-xs text-red-400">{fetchDbError}</p>
          )}

          {availableDbs.length === 0 && !fetchingDbs && !fetchDbError && (
            <p className="text-xs text-slate-500 italic">
              Click Fetch to load available databases from the server.
            </p>
          )}

          {availableDbs.length > 0 && (
            <>
              <div className="max-h-40 overflow-y-auto rounded border border-surface-700 bg-surface-950 divide-y divide-surface-800">
                {availableDbs.map(db => (
                  <label key={db} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-800">
                    <input
                      type="checkbox"
                      checked={selectedDbs.includes(db)}
                      onChange={() => toggleDb(db)}
                      className="rounded"
                    />
                    <Database size={11} className="text-yellow-400 flex-shrink-0" />
                    <span className="text-xs text-slate-300">{db}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                {selectedDbs.length === 0
                  ? 'No selection — all databases will be shown'
                  : `${selectedDbs.length} of ${availableDbs.length} selected`}
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
