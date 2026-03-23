/**
 * Write text to clipboard with a fallback for non-secure contexts (plain HTTP).
 * navigator.clipboard is only available over HTTPS or localhost.
 */
export async function clipboardWrite(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Fallback: execCommand works without a secure context
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('Copy failed')
}
