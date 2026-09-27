/**
 * Clamp a floating element's anchored position so it stays within the
 * viewport. Measures `el`'s layout box (`offsetWidth`/`offsetHeight`), not
 * `getBoundingClientRect()`: a menu's enter animation applies `scale(0.9)`
 * while this runs, and the scaled-down rect reads ~10% too small, letting the
 * menu overflow the viewport edge it was meant to be clamped against.
 */
export function clampToViewport(x: number, y: number, el: HTMLElement, margin = 8) {
  return {
    left: Math.max(margin, Math.min(x, window.innerWidth - el.offsetWidth - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - el.offsetHeight - margin)),
  }
}
