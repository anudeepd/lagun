import Modal from './Modal'
import Button from './Button'
import { SHORTCUTS, type Shortcut, type ShortcutGroup } from '../../utils/shortcuts'
import Label from './Label'

interface Props {
  open: boolean
  onClose: () => void
}

// Built once from the registry so the sheet has no hand-written rows to drift:
// a shortcut added to `utils/shortcuts.ts` shows up here automatically, and the
// sections follow the order the groups first appear in that list.
const GROUPS: Array<{ group: ShortcutGroup; shortcuts: Shortcut[] }> = []
for (const shortcut of SHORTCUTS) {
  const existing = GROUPS.find(entry => entry.group === shortcut.group)
  if (existing) existing.shortcuts.push(shortcut)
  else GROUPS.push({ group: shortcut.group, shortcuts: [shortcut] })
}

export default function ShortcutHelpDialog({ open, onClose }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard Shortcuts"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        {GROUPS.map(({ group, shortcuts }) => (
          <section key={group}>
            <Label as="h3" className="mb-1">{group}</Label>
            <dl className="divide-y divide-surface-800">
              {shortcuts.map(shortcut => (
                <div key={`${shortcut.group}-${shortcut.label}`} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                  <dt className="text-slate-300">{shortcut.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map(key => (
                      <kbd key={key} className="rounded border border-surface-700 bg-surface-800 px-2 py-1 font-mono text-xs text-slate-200">{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
