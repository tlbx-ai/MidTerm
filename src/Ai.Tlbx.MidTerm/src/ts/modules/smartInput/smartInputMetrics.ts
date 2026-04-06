const COLLAPSED_TEXTAREA_LINES = 1;
const MAX_TEXTAREA_OVERLAY_LINES = 8;
const MAX_VISIBLE_TEXTAREA_LINES = COLLAPSED_TEXTAREA_LINES + MAX_TEXTAREA_OVERLAY_LINES;
const MOBILE_BREAKPOINT_PX = 768;

export function resizeSmartInputTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';

  const computedStyle = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  const fallbackFontSize = Number.parseFloat(computedStyle.fontSize) || 16;
  const effectiveLineHeight = Number.isFinite(lineHeight) ? lineHeight : fallbackFontSize * 1.2;
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;
  const minHeight = Number.parseFloat(computedStyle.minHeight) || 0;
  const maxHeight =
    effectiveLineHeight * MAX_VISIBLE_TEXTAREA_LINES +
    paddingTop +
    paddingBottom +
    borderTop +
    borderBottom;
  const contentHeight = textarea.scrollHeight + borderTop + borderBottom;
  const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));

  textarea.style.height = `${String(nextHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function getCollapsedSmartInputTextareaHeight(textarea: HTMLTextAreaElement): number {
  const computedStyle = getComputedStyle(textarea);
  const configuredMinHeight = Number.parseFloat(computedStyle.minHeight);
  if (Number.isFinite(configuredMinHeight) && configuredMinHeight > 0) {
    return configuredMinHeight;
  }

  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  const fallbackFontSize = Number.parseFloat(computedStyle.fontSize) || 16;
  const effectiveLineHeight = Number.isFinite(lineHeight) ? lineHeight : fallbackFontSize * 1.2;
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;

  return effectiveLineHeight + paddingTop + paddingBottom + borderTop + borderBottom;
}

export function isMobileViewport(): boolean {
  return window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT_PX)}px)`).matches;
}

export function isTouchPrimaryDevice(): boolean {
  return !matchMedia('(hover: hover) and (pointer: fine)').matches;
}
