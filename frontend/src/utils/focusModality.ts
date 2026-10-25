const MODIFIER_KEYS: Record<string, true> = {
  Shift: true, Control: true, Alt: true, Meta: true, AltGraph: true, CapsLock: true,
}

/** Keep modifier-only gestures from revealing focus left behind by a pointer. */
export function installFocusModality(doc: Document = document): () => void {
  const root = doc.documentElement
  root.dataset.focusModality = 'keyboard'

  const onPointerDown = () => { root.dataset.focusModality = 'pointer' }
  const onKeyDown = (event: KeyboardEvent) => {
    // Shortcuts and modifier-only gestures are not keyboard navigation.
    // Shift+Tab still reaches this branch because its key is Tab.
    if (MODIFIER_KEYS[event.key] || event.metaKey || event.ctrlKey || event.altKey) return
    root.dataset.focusModality = 'keyboard'
  }

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown, true)
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onKeyDown, true)
    delete root.dataset.focusModality
  }
}
