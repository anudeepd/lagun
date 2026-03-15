import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import Modal from '../ui/Modal'
import Button from '../ui/Button'
import Input from '../ui/Input'
import { api } from '../../api/client'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ConfigExportDialog({ open, onClose }: Props) {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClose = () => {
    setPassphrase('')
    setConfirm('')
    setError(null)
    onClose()
  }

  const handleExport = async () => {
    setError(null)
    if (!passphrase) {
      setError('Enter a passphrase to protect the exported passwords.')
      return
    }
    if (passphrase !== confirm) {
      setError('Passphrases do not match.')
      return
    }
    setLoading(true)
    try {
      await api.exportConfig(passphrase)
      handleClose()
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
      title="Export Connections"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" onClick={handleExport} disabled={loading}>
            {loading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Download size={12} className="mr-1" />}
            Download
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-slate-400">
          Export all saved connections to an encrypted JSON file. You will need this
          passphrase to import the file on any Lagun instance.
        </p>
        <Input
          label="Passphrase"
          type="password"
          value={passphrase}
          onChange={e => setPassphrase(e.target.value)}
          placeholder="Strong passphrase"
          autoComplete="new-password"
        />
        <Input
          label="Confirm passphrase"
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Repeat passphrase"
          autoComplete="new-password"
          onKeyDown={e => e.key === 'Enter' && handleExport()}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </Modal>
  )
}
