function legacyClipboardWrite(text: string): void {
  if (typeof document.execCommand !== 'function') {
    throw new Error('Clipboard API is unavailable')
  }

  const ta = document.createElement('textarea')
  // The copy handler supplies the real text. Keeping the textarea itself tiny
  // matters: putting a multi-megabyte value in the DOM makes the browser lay
  // out the whole app before it can execute the copy command, which can outlast
  // the user-activation window.
  ta.value = ' '
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '1px'
  ta.style.height = '1px'
  ta.style.opacity = '0'
  ta.style.pointerEvents = 'none'
  document.body.appendChild(ta)

  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0
    ? selection.getRangeAt(0).cloneRange()
    : null

  ta.focus()
  ta.select()
  ta.setSelectionRange(0, ta.value.length)

  let payloadSet = false
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
    payloadSet = true
  }
  document.addEventListener('copy', copy, true)
  let ok: boolean
  try {
    ok = document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', copy, true)
    document.body.removeChild(ta)
    if (selection) {
      selection.removeAllRanges()
      if (previousRange) selection.addRange(previousRange)
    }
  }

  if (!ok || !payloadSet) throw new Error('Copy failed')
}

/**
 * Write text to clipboard with a fallback for non-secure contexts, older
 * browsers, and Safari cases where navigator.clipboard exists but rejects.
 */
export async function clipboardWrite(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to execCommand. Safari can expose navigator.clipboard but
      // still reject writes depending on permissions/user activation.
    }
  }
  legacyClipboardWrite(text)
}
