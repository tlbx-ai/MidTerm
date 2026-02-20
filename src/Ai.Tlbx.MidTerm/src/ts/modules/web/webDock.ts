/**
 * Web Preview Dock
 *
 * Dock/undock logic for the web preview panel.
 * Unlike commands/git docks, this panel COEXISTS with other docks.
 * The web preview dock sits as the outermost (rightmost) panel.
 */

import { $webPreviewDocked, $isMainBrowser } from '../../stores';
import { rescaleAllTerminalsImmediate, autoResizeAllTerminalsImmediate } from '../terminal/scaling';
import { setActionButtonActive } from '../sessionTabs';
import { restoreLastUrl, showIframe, unloadIframe, releaseCaptureStream } from './webPanel';
import { cleanupDetach } from './webDetach';
import { clearWebPreviewTarget } from './webApi';
import { createLogger } from '../logging';

const log = createLogger('webDock');

const DOCK_MIN_WIDTH = 250;
const DOCK_MAX_WIDTH = 800;
const DOCK_WIDTH_KEY = 'mt-web-preview-dock-width';

function handleDockLayoutChange(): void {
  if ($isMainBrowser.get()) {
    autoResizeAllTerminalsImmediate();
  } else {
    requestAnimationFrame(rescaleAllTerminalsImmediate);
  }
}

/**
 * Get the current web preview dock width (0 if hidden).
 */
export function getWebPreviewDockWidth(): number {
  const dock = document.getElementById('web-preview-dock');
  if (dock && !dock.classList.contains('hidden')) return dock.offsetWidth;
  return 0;
}

/**
 * Adjust the CSS `right` position of inner docks (commands, git, file-viewer)
 * so they sit to the left of the web preview dock.
 */
export function adjustInnerDockPositions(): void {
  const wpWidth = getWebPreviewDockWidth();
  for (const id of ['git-dock', 'commands-dock', 'file-viewer-dock']) {
    const el = document.getElementById(id);
    if (el) el.style.right = wpWidth > 0 ? wpWidth + 'px' : '';
  }
}

/**
 * Recalculate the combined marginRight for all visible dock panels
 * on session-tab-panels elements.
 */
export function updateAllDockMargins(): void {
  let total = 0;
  for (const id of ['git-dock', 'commands-dock', 'file-viewer-dock', 'web-preview-dock']) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) total += el.offsetWidth;
  }
  document
    .querySelectorAll<HTMLElement>('.session-tab-panels')
    .forEach((p) => (p.style.marginRight = total > 0 ? total + 'px' : ''));
}

export function toggleWebPreviewDock(): void {
  if ($webPreviewDocked.get()) {
    closeWebPreviewDock();
  } else {
    openWebPreviewDock();
  }
}

function openWebPreviewDock(): void {
  $webPreviewDocked.set(true);
  setActionButtonActive('web', true);

  const dockPanel = document.getElementById('web-preview-dock');
  if (!dockPanel) return;

  dockPanel.classList.remove('hidden');

  // Restore saved width
  const savedWidth = localStorage.getItem(DOCK_WIDTH_KEY);
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= DOCK_MIN_WIDTH && w <= DOCK_MAX_WIDTH) {
      dockPanel.style.width = w + 'px';
    }
  }

  showIframe();
  restoreLastUrl();

  // Adjust inner docks and margins for coexistence
  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();

  log.info(() => 'Web preview dock opened');
}

export function closeWebPreviewDock(): void {
  $webPreviewDocked.set(false);
  setActionButtonActive('web', false);

  // Unload iframe to stop all network activity
  unloadIframe();
  cleanupDetach();
  clearWebPreviewTarget();
  releaseCaptureStream();

  const dockPanel = document.getElementById('web-preview-dock');
  if (dockPanel) {
    dockPanel.classList.add('hidden');
    dockPanel.style.width = '';
  }

  // Reset inner dock positions and margins
  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();

  log.info(() => 'Web preview dock closed');
}

export function setupWebPreviewDockResize(): void {
  const dockPanel = document.getElementById('web-preview-dock');
  const grip = dockPanel?.querySelector('.web-preview-dock-resize-grip') as HTMLElement;
  if (!dockPanel || !grip) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  function beginResize(clientX: number): void {
    isResizing = true;
    startX = clientX;
    startWidth = dockPanel!.offsetWidth;
    grip.classList.add('active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  function updateResize(clientX: number): void {
    if (!isResizing) return;
    const delta = startX - clientX;
    const newWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, startWidth + delta));
    dockPanel!.style.width = newWidth + 'px';
    adjustInnerDockPositions();
    updateAllDockMargins();
  }

  function endResize(): void {
    if (!isResizing) return;
    isResizing = false;
    grip.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(DOCK_WIDTH_KEY, String(dockPanel!.offsetWidth));
    handleDockLayoutChange();
  }

  grip.addEventListener('mousedown', (e: MouseEvent) => {
    beginResize(e.clientX);
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => updateResize(e.clientX));
  document.addEventListener('mouseup', endResize);

  grip.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      beginResize(e.touches[0]!.clientX);
      e.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (!isResizing || e.touches.length !== 1) return;
      updateResize(e.touches[0]!.clientX);
      e.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener('touchend', endResize);
  document.addEventListener('touchcancel', endResize);
}
