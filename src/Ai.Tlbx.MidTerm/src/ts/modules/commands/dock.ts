/**
 * Commands Dock
 *
 * Dock/undock logic for snapping the commands script list
 * to the right sidebar. Follows the file viewer dock pattern.
 */

import {
  $commandsPanelDocked,
  $activeSessionId,
  $fileViewerDocked,
  $dockedFilePath,
} from '../../stores';
import { rescaleAllTerminalsImmediate } from '../terminal/scaling';
import { switchTab } from '../sessionTabs';
import { renderCommandsPanelInto } from './commandsPanel';
import { createLogger } from '../logging';

const log = createLogger('commandsDock');

const DOCK_MIN_WIDTH = 250;
const DOCK_MAX_WIDTH = 600;
const DOCK_WIDTH_KEY = 'mt-commands-dock-width';

let activeUnsub: (() => void) | null = null;

function closeFileViewerDockIfOpen(): void {
  if (!$fileViewerDocked.get()) return;
  $fileViewerDocked.set(false);
  $dockedFilePath.set(null);
  const fvDock = document.getElementById('file-viewer-dock');
  if (fvDock) fvDock.classList.add('hidden');
  document.getElementById('app')?.classList.remove('file-viewer-docked');
}

export function dockCommandsPanel(sessionId: string): void {
  closeFileViewerDockIfOpen();

  $commandsPanelDocked.set(true);

  const dockPanel = document.getElementById('commands-dock');
  const app = document.getElementById('app');
  if (!dockPanel) return;

  dockPanel.classList.remove('hidden');
  app?.classList.add('commands-docked');

  // Apply saved width
  const savedWidth = localStorage.getItem(DOCK_WIDTH_KEY);
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= DOCK_MIN_WIDTH && w <= DOCK_MAX_WIDTH) {
      dockPanel.style.width = w + 'px';
      const terminalsArea = document.querySelector('.terminals-area') as HTMLElement;
      if (terminalsArea) terminalsArea.style.marginRight = w + 'px';
    }
  }

  // Render script list into dock body
  const body = dockPanel.querySelector('.commands-dock-body') as HTMLElement;
  if (body) {
    body.innerHTML = '';
    renderCommandsPanelInto(body, sessionId);
  }

  // Switch tab back to terminal
  switchTab(sessionId, 'terminal');

  requestAnimationFrame(rescaleAllTerminalsImmediate);

  // Track active session changes to refresh dock content
  activeUnsub?.();
  activeUnsub = $activeSessionId.subscribe((newId) => {
    if (!$commandsPanelDocked.get() || !newId) return;
    const dockBody = document
      .getElementById('commands-dock')
      ?.querySelector('.commands-dock-body') as HTMLElement;
    if (dockBody) {
      dockBody.innerHTML = '';
      renderCommandsPanelInto(dockBody, newId);
    }
  });

  log.info(() => 'Commands panel docked');
}

export function undockCommandsPanel(): void {
  closeDockInternal();

  const activeId = $activeSessionId.get();
  if (activeId) {
    switchTab(activeId, 'commands');
  }

  log.info(() => 'Commands panel undocked');
}

export function closeCommandsDock(): void {
  closeDockInternal();
  log.info(() => 'Commands dock closed');
}

function closeDockInternal(): void {
  activeUnsub?.();
  activeUnsub = null;

  $commandsPanelDocked.set(false);

  const dockPanel = document.getElementById('commands-dock');
  const app = document.getElementById('app');

  if (dockPanel) {
    dockPanel.classList.add('hidden');
    dockPanel.style.width = '';
  }
  app?.classList.remove('commands-docked');

  const terminalsArea = document.querySelector('.terminals-area') as HTMLElement;
  if (terminalsArea) terminalsArea.style.marginRight = '';

  requestAnimationFrame(rescaleAllTerminalsImmediate);
}

export function setupDockResize(): void {
  const dockPanel = document.getElementById('commands-dock');
  const grip = dockPanel?.querySelector('.commands-dock-resize-grip') as HTMLElement;
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
    const terminalsArea = document.querySelector('.terminals-area') as HTMLElement;
    if (terminalsArea) terminalsArea.style.marginRight = newWidth + 'px';
  }

  function endResize(): void {
    if (!isResizing) return;
    isResizing = false;
    grip.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(DOCK_WIDTH_KEY, String(dockPanel!.offsetWidth));
    requestAnimationFrame(rescaleAllTerminalsImmediate);
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
