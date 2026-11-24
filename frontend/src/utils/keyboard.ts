/**
 * True while Enter is confirming an IME composition.
 *
 * `isComposing` covers modern browsers. Safari can deliver the confirming
 * keydown after resetting it, so the legacy `keyCode` process-key marker is
 * still required there.
 */
interface ImeKeyboardEvent {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

export function isImeComposing(event: ImeKeyboardEvent): boolean {
  const source = event.nativeEvent ?? event
  return source.isComposing === true || source.keyCode === 229
}
