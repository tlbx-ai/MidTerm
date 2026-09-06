/** Keep the terminal boundary while the OS keyboard yields its space to our keys. */
export const KEYBOARD_REPLACEMENT_CHANGED = 'midterm:keyboard-replacement-changed';
let shellHeight: number | null = null;
let openingWidth = 0;
let returningToNative = false;

export function openKeyboardReplacement(): void {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const nativeKeyboardVisible = document.body.classList.contains('keyboard-visible');
  returningToNative = false;
  shellHeight = nativeKeyboardVisible ? height : height - Math.min(320, height * 0.45);
  openingWidth = viewport?.width ?? window.innerWidth;
  document.body.classList.add('keyboard-replacement');
  window.dispatchEvent(new Event(KEYBOARD_REPLACEMENT_CHANGED));
  (document.activeElement as HTMLElement | null)?.blur();
}

export function closeKeyboardReplacement(): void {
  if (shellHeight === null) return;
  shellHeight = null;
  returningToNative = false;
  document.body.classList.remove('keyboard-replacement');
  window.dispatchEvent(new Event(KEYBOARD_REPLACEMENT_CHANGED));
}

export function returnToNativeKeyboard(): void {
  returningToNative = true;
}

export function getKeyboardReplacementHeight(
  viewportHeight: number,
  viewportWidth: number,
): number | null {
  if (shellHeight === null) return null;
  if (returningToNative && viewportHeight <= shellHeight + 4) {
    closeKeyboardReplacement();
    return null;
  }
  if (Math.abs(viewportWidth - openingWidth) > 1) {
    closeKeyboardReplacement();
    return null;
  }
  return Math.min(viewportHeight, shellHeight);
}
