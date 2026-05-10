import { $isMainBrowser } from '../../stores';
import { autoResizeAllTerminalsImmediate, rescaleAllTerminals } from './scaling';
import {
  observeMobileVerticalViewportChange,
  syncMobileVerticalStableTerminals,
} from './mobileVerticalStability';

const KEYBOARD_RATIO_THRESHOLD = 0.88;
const KEYBOARD_PIXEL_THRESHOLD = 120;

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
  if (appEl) {
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
    `${visualViewport.offsetTop}px`,
  );
  document.body.style.height = `${viewportHeight}px`;
  document.body.style.maxHeight = `${viewportHeight}px`;

  if (visualViewport.offsetTop !== 0 && !hasEditableElementFocus()) {
    window.scrollTo(0, 0);
  }
}

function syncSoftKeyboardState(viewportHeight: number, baselineHeight: number): void {
  const heightDrop = baselineHeight - viewportHeight;
  document.documentElement.style.setProperty(
    '--midterm-soft-keyboard-height',
    `${Math.max(0, heightDrop)}px`,
  );
  const kbVisible =
    viewportHeight < baselineHeight * KEYBOARD_RATIO_THRESHOLD &&
    heightDrop >= KEYBOARD_PIXEL_THRESHOLD;
  if (kbVisible !== document.body.classList.contains('keyboard-visible')) {
    document.body.classList.toggle('keyboard-visible', kbVisible);
  }
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
  let baselineHeight = Math.max(window.innerHeight, vv.height);
  const appEl = document.querySelector<HTMLElement>('.terminal-page');

  const update = () => {
    const vh = vv.height;
    if (vh > baselineHeight) {
      baselineHeight = vh;
    }
    if (Math.abs(vh - lastHeight) < 1) return;
    lastHeight = vh;

    applyVisualViewportShellGeometry(vv, vh, appEl);
    syncSoftKeyboardState(vh, baselineHeight);

    if (typeof Reflect.get(window, 'dispatchEvent') === 'function')
      window.dispatchEvent(new Event('midterm:visual-viewport-changed'));

    const mobileVerticalOnlyChange = observeMobileVerticalViewportChange();
    if (mobileVerticalOnlyChange) {
      syncMobileVerticalStableTerminals();
      return;
    }

    if ($isMainBrowser.get()) {
      autoResizeAllTerminalsImmediate();
    } else {
      rescaleAllTerminals();
    }
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
