import { useEffect, type RefObject } from 'react'

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])'

export default function useMenuKeyboard(
  menuRef: RefObject<HTMLElement>,
  onClose: () => void,
  active = true,
) {
  useEffect(() => {
    if (!active) return
    const menu = menuRef.current
    if (!menu) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const getItems = () => Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR))

    const focusFirst = window.requestAnimationFrame(() => getItems()[0]?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      const items = getItems()
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (items.length === 0) return
      let nextIndex: number | null = null
      if (event.key === 'ArrowDown') nextIndex = index < 0 ? 0 : (index + 1) % items.length
      if (event.key === 'ArrowUp') nextIndex = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
      if (event.key === 'Home') nextIndex = 0
      if (event.key === 'End') nextIndex = items.length - 1
      if (nextIndex !== null) {
        event.preventDefault()
        items[nextIndex]?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      window.removeEventListener('keydown', onKeyDown)
      if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus())
    }
  }, [active, menuRef, onClose])
}
