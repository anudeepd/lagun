import { useId, useRef } from 'react'
import Modal from './Modal'
import Button from './Button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const messageId = useId()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      // Destructive confirmations are announced as an alert dialog, and the
      // consequence text is linked so it is read with the title rather than
      // being available only by navigating into the dialog.
      alert
      descriptionId={messageId}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            type="button"
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button ref={cancelRef} type="button" variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
        </>
      }
    >
      <p id={messageId} className="text-pretty text-sm text-slate-300">{message}</p>
    </Modal>
  )
}
