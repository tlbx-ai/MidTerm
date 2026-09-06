import { getKeyboardReplacementHeight, KEYBOARD_REPLACEMENT_CHANGED } from './keyboardReplacement';
import { autoResizeAllTerminalsImmediate } from './scaling';
import {
  isMobileTerminalViewport,
  observeMobileVerticalViewportChange,
  rememberCurrentMobileViewportSnapshot,
  setMobileVerticalStability,
  syncMobileVerticalStableTerminals,
} from './mobileVerticalStability';
import { isMobilePresentationContext } from '../theming/backgroundVisibility';

const KEYBOARD_RATIO_THRESHOLD = 0.88;
const KEYBOARD_PIXEL_THRESHOLD = 120;
const LAYOUT_VISUAL_VIEWPORT_HEIGHT_TOLERANCE_PX = 2;
const KEYBOARD_VIEWPORT_JITTER_TOLERANCE_PX = 4;

function getVisualViewportShellTop(visualViewport: VisualViewport): number {
  // Chromium with interactive-widget=resizes-content already moves the layout
  // boundary above the keyboard. Its visual viewport may still emit transient
  // offsetTop values while the focused textarea is edited; following those
  // values would move the entire app on every keystroke. Browsers that keep the
  // larger layout viewport (notably iOS) still need the visual offset fallback.
  const layoutViewportTracksVisualViewport =
    Math.abs(window.innerHeight - visualViewport.height) <=
    LAYOUT_VISUAL_VIEWPORT_HEIGHT_TOLERANCE_PX;
  return layoutViewportTracksVisualViewport ? 0 : Math.max(0, visualViewport.offsetTop);
}

function hasEditableElementFocus(): boolean {
  const activeElement = document.activeElement as {
    tagName?: string | null;
    isContentEditable?: boolean | null;
  } | null;
  if (!activeElement || typeof activeElement.tagName !== 'string') {
    return false;
  }

  const tagName = activeElement.tagName.toUpperCase();
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    activeElement.isContentEditable === true
  );
}

function applyVisualViewportShellGeometry(
  visualViewport: VisualViewport,
  viewportHeight: number,
  appEl: HTMLElement | null,
): void {
  const viewportTop = getVisualViewportShellTop(visualViewport);
  if (appEl) {
    appEl.style.top = `${viewportTop}px`;
    appEl.style.bottom = 'auto';
    appEl.style.height = `${viewportHeight}px`;
    appEl.style.maxHeight = `${viewportHeight}px`;
  }

  // Lock root/body to visual viewport height to prevent dragging hidden
  // off-screen space (common when soft keyboard is open in mobile PWAs).
  document.documentElement.style.height = `${viewportHeight}px`;
  document.documentElement.style.maxHeight = `${viewportHeight}px`;
  document.documentElement.style.setProperty(
    '--midterm-visual-viewport-height',
    `${viewportHeight}px`,
  );
  document.documentElement.style.setProperty(
    '--midterm-visual-viewport-offset-top',
    `${viewportTop}px`,
  );
  document.body.style.height = `${viewportHeight}px`;
  document.body.style.maxHeight = `${viewportHeight}px`;

  if (viewportTop !== 0 && !hasEditableElementFocus()) {
    window.scrollTo(0, 0);
  }
}

function clearVisualViewportShellGeometry(appEl: HTMLElement | null): void {
  if (appEl) {
    appEl.style.removeProperty('top');
    appEl.style.removeProperty('bottom');
    appEl.style.removeProperty('height');
    appEl.style.removeProperty('max-height');
  }

  document.documentElement.style.removeProperty('height');
  document.documentElement.style.removeProperty('max-height');
  document.documentElement.style.removeProperty('--midterm-visual-viewport-height');
  document.documentElement.style.removeProperty('--midterm-visual-viewport-offset-top');
  document.documentElement.style.removeProperty('--midterm-soft-keyboard-height');
  document.body.style.removeProperty('height');
  document.body.style.removeProperty('max-height');
  document.body.classList.toggle('keyboard-visible', false);
}

function shouldConstrainShellToVisualViewport(visualViewport: VisualViewport): boolean {
  return (
    isMobilePresentationContext() ||
    isMobileTerminalViewport(Math.round(visualViewport.width || window.innerWidth))
  );
}

function isSoftKeyboardVisible(viewportHeight: number, baselineHeight: number): boolean {
  const heightDrop = baselineHeight - viewportHeight;
  return (
    viewportHeight < baselineHeight * KEYBOARD_RATIO_THRESHOLD &&
    heightDrop >= KEYBOARD_PIXEL_THRESHOLD
  );
}

function isConstrainedSoftKeyboardVisible(
  constrainShell: boolean,
  viewportHeight: number,
  baselineHeight: number,
): boolean {
  if (!constrainShell) {
    return false;
  }
  return isSoftKeyboardVisible(viewportHeight, baselineHeight);
}

function syncSoftKeyboardState(
  viewportHeight: number,
  baselineHeight: number,
  replacementActive: boolean,
): boolean {
  const heightDrop = baselineHeight - viewportHeight;
  document.documentElement.style.setProperty(
    '--midterm-soft-keyboard-height',
    `${Math.max(0, heightDrop)}px`,
  );
  const kbVisible = replacementActive || isSoftKeyboardVisible(viewportHeight, baselineHeight);
  if (kbVisible !== document.body.classList.contains('keyboard-visible')) {
    document.body.classList.toggle('keyboard-visible', kbVisible);
  }
  return kbVisible;
}

function resizeTerminalsForKeyboardViewport(
  keyboardVisible: boolean,
  keyboardVisibilityChanged: boolean,
): boolean {
  if (!keyboardVisible && !keyboardVisibilityChanged) {
    return false;
  }

  // The size-controlling mobile browser must publish the rows that really
  // fit above the OSK. Keep tiny focused-input viewport jitter suppressed,
  // but treat every stable keyboard open/close boundary as authoritative.
  rememberCurrentMobileViewportSnapshot();
  setMobileVerticalStability(false, { preserveScrollPosition: true });
  autoResizeAllTerminalsImmediate();
  return true;
}

function syncKeyboardReplacementGeometry(
  constrainShell: boolean,
  vv: VisualViewport,
): { replacementHeight: number | null; vh: number } {
  const rawViewportHeight = vv.height;
  const replacementHeight = constrainShell
    ? getKeyboardReplacementHeight(rawViewportHeight, vv.width || window.innerWidth)
    : null;
  const vh = Math.max(1, replacementHeight ?? rawViewportHeight);
  document.documentElement.style.setProperty(
    '--midterm-keyboard-panel-height',
    `${replacementHeight === null ? 0 : Math.max(0, rawViewportHeight - vh)}px`,
  );
  return { replacementHeight, vh };
}

/**
 * Set up visual viewport handling for mobile keyboard appearance.
 * Constrains the .terminal-page height to the visual viewport so the entire
 * flex layout (topbar, terminals, touch controller) fits above the keyboard.
 * Also toggles a 'keyboard-visible' class on body to hide UI chrome.
 */
export function setupVisualViewport(): void {
  if (!window.visualViewport) return;

  const vv = window.visualViewport;
  let lastHeight = 0;
  let lastTop = -1;
  let lastWidth = 0;
  let baselineHeight = Math.max(window.innerHeight, vv.height);
  let lastKeyboardVisible = false;
  const appEl = document.querySelector<HTMLElement>('.terminal-page');

  const update = () => {
    const rawViewportHeight = vv.height;
    if (rawViewportHeight > baselineHeight) {
      baselineHeight = rawViewportHeight;
    }
    const constrainShell = shouldConstrainShellToVisualViewport(vv);
    const { replacementHeight, vh } = syncKeyboardReplacementGeometry(constrainShell, vv);
    const viewportTop = getVisualViewportShellTop(vv);
    const viewportWidth = Math.max(1, vv.width || window.innerWidth);
    const keyboardVisible =
      replacementHeight !== null ||
      isConstrainedSoftKeyboardVisible(constrainShell, rawViewportHeight, baselineHeight);
    const keyboardVisibilityChanged = keyboardVisible !== lastKeyboardVisible;
    const keyboardGeometryStable =
      Math.abs(vh - lastHeight) <= KEYBOARD_VIEWPORT_JITTER_TOLERANCE_PX &&
      Math.abs(viewportWidth - lastWidth) < 1;
    if (keyboardVisible && hasEditableElementFocus() && keyboardGeometryStable) {
      // Mobile browsers can pan the focused xterm/prompt textarea on every
      // character and jitter the reported height by a few subpixels. Neither
      // changes the usable terminal boundary, so following them would move the
      // whole shell and repeat terminal synchronization on every keystroke.
      return;
    }
    if (
      Math.abs(vh - lastHeight) < 1 &&
      Math.abs(viewportTop - lastTop) < 1 &&
      Math.abs(viewportWidth - lastWidth) < 1
    )
      return;
    lastHeight = vh;
    lastTop = viewportTop;
    lastWidth = viewportWidth;
    lastKeyboardVisible = keyboardVisible;

    if (constrainShell) {
      applyVisualViewportShellGeometry(vv, vh, appEl);
      syncSoftKeyboardState(rawViewportHeight, baselineHeight, replacementHeight !== null);
    } else {
      clearVisualViewportShellGeometry(appEl);
    }

    if (typeof Reflect.get(window, 'dispatchEvent') === 'function')
      window.dispatchEvent(new Event('midterm:visual-viewport-changed'));

    if (resizeTerminalsForKeyboardViewport(keyboardVisible, keyboardVisibilityChanged)) {
      return;
    }

    const mobileVerticalOnlyChange = observeMobileVerticalViewportChange();
    if (mobileVerticalOnlyChange) {
      syncMobileVerticalStableTerminals();
      return;
    }

    autoResizeAllTerminalsImmediate();
  };

  window.addEventListener(KEYBOARD_REPLACEMENT_CHANGED, () => {
    lastHeight = 0;
    update();
  });
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
