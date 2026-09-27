import { useEffect, useRef, type RefObject } from 'react'

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])'

export default function useMenuKeyboard(
  menuRef: RefObject<HTMLElement>,
  onClose: () => void,
  active = true,
) {
  // Set when the menu closes via Tab so cleanup does not pull focus back to
  // the opener after the browser has already advanced it.
  const tabAdvanceRef = useRef(false)
  // onClose as ref: callers pass inline closures, new identity each render.
  // Effect must not resubscribe + refocus first item on every parent render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const stableOnClose = useRef(() => onCloseRef.current()).current
  useEffect(() => {
    if (!active) return
    tabAdvanceRef.current = false
    const menu = menuRef.current
    if (!menu) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const getItems = () => Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR))

    const focusFirst = window.requestAnimationFrame(() => getItems()[0]?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement
      // The listener is window-wide, but a menu can stay open while focus has
      // moved elsewhere (a click that does not dismiss it). Tab and the arrow
      // keys then belong to whatever has focus — an editor, a form field — and
      // must not be pulled into the menu. Escape still closes it from anywhere.
      const focusInMenu = menu.contains(active) || (opener !== null && active === opener)
      if (event.key !== 'Escape' && !focusInMenu) return
      const items = getItems()
      const index = items.indexOf(active as HTMLElement)
      if (event.key === 'Escape') {
        event.preventDefault()
        stableOnClose()
        return
      }
      if (event.key === 'Tab') {
        // Close the menu but let focus advance natively. Parking focus on the
        // opener first keeps tab order anchored when the portal unmounts
        // instead of stranding focus on a detached menu item.
        tabAdvanceRef.current = true
        if (opener?.isConnected) opener.focus()
        stableOnClose()
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
      const advancedWithTab = tabAdvanceRef.current
      tabAdvanceRef.current = false
      if (!advancedWithTab && opener?.isConnected) window.requestAnimationFrame(() => opener.focus())
    }
  }, [active, menuRef, stableOnClose])
}
