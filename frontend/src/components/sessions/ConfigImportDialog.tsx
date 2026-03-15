import { useState } from 'react'
import { Upload, Loader2, CheckCircle } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import { api } from '../../api/client'
import { useSessionStore } from '../../store/sessionStore'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ConfigImportDialog({ open, onClose }: Props) {
  const { loadSessions } = useSessionStore()
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleClose = () => {
    setFile(null)
    setPassphrase('')
    setResult(null)
    setError(null)
    onClose()
  }

  const handleImport = async () => {
    if (!file) { setError('Select a file first.'); return }
    if (!passphrase) { setError('Enter the passphrase used during export.'); return }
    setLoading(true)
    setError(null)
    try {
      const r = await api.importConfig(file, passphrase)
      setResult(r)
      await loadSessions()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import Connections"
      width="max-w-md"
      footer={
        result ? (
          <Button variant="primary" onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button variant="primary" onClick={handleImport} disabled={loading || !file}>
              {loading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Upload size={12} className="mr-1" />}
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle size={32} className="text-green-400" />
          <p className="text-sm text-slate-200 font-medium">Import complete</p>
          <p className="text-xs text-slate-400">
            {result.imported} connection{result.imported !== 1 ? 's' : ''} imported
            {result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-slate-400">
            Select a Lagun export file (.json) to restore saved connections.
          </p>
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
              Export file
            </label>
            <input
              type="file"
              accept=".json,application/json"
              onChange={e => { setFile(e.target.files?.[0] ?? null); setError(null) }}
              className="text-sm text-slate-300 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0
                         file:text-xs file:font-medium file:bg-surface-700 file:text-slate-200
                         hover:file:bg-surface-600 cursor-pointer"
            />
          </div>
          <Input
            label="Passphrase"
            type="password"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder="Passphrase used during export"
            autoComplete="current-password"
            onKeyDown={e => e.key === 'Enter' && handleImport()}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
