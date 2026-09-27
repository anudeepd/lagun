import { useEffect, useState } from 'react'

/**
 * True from the first time `open` becomes true, and forever after.
 *
 * Lazily loaded dialogs are kept mounted while closed so their exit animation
 * can play, but mounting them unconditionally fetches their chunk on every
 * render even when the user never opens them. Gate the mount on this flag:
 * `open` stays the source of truth for the dialog itself, so once it has been
 * opened it stays mounted and closing still animates out.
 */
export default function useEverOpened(open: boolean): boolean {
  const [everOpened, setEverOpened] = useState(open)

  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])

  return everOpened
}
