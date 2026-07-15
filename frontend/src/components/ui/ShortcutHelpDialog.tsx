import Modal from './Modal'
import Button from './Button'

interface Props {
  open: boolean
  onClose: () => void
}

const shortcuts = [
  ['Ctrl/Cmd + K', 'Open command palette'],
  ['Ctrl/Cmd + Enter', 'Run query'],
  ['Arrow Left/Right', 'Switch tabs when tab bar focused'],
  ['Shift + Enter', 'Open large cell editor'],
  ['Escape', 'Close dialog or menu'],
  ['?', 'Open this help'],
]

export default function ShortcutHelpDialog({ open, onClose }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard Shortcuts"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <dl className="divide-y divide-surface-800">
        {shortcuts.map(([keys, action]) => (
          <div key={keys} className="flex items-center justify-between gap-4 py-2.5 text-sm">
            <dt className="text-slate-300">{action}</dt>
            <dd className="shrink-0 rounded border border-surface-700 bg-surface-800 px-2 py-1 font-mono text-xs text-slate-200">{keys}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
