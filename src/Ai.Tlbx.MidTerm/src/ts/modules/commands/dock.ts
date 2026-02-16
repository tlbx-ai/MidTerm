/**
 * Commands Dock
 *
 * Dock/undock logic for snapping the commands script list
 * to the right sidebar.
 */

import {
  $commandsPanelDocked,
  $activeSessionId,
  $fileViewerDocked,
  $dockedFilePath,
  $gitPanelDocked,
} from '../../stores';
import { rescaleAllTerminalsImmediate } from '../terminal/scaling';
import { setActionButtonActive } from '../sessionTabs';
import { renderCommandsPanelInto } from './commandsPanel';
import { createLogger } from '../logging';

const log = createLogger('commandsDock');

const DOCK_MIN_WIDTH = 250;
const DOCK_MAX_WIDTH = 600;
const DOCK_WIDTH_KEY = 'mt-commands-dock-width';

let activeUnsub: (() => void) | null = null;
let closeGitDockFn: (() => void) | null = null;

export function registerGitDockCloser(fn: () => void): void {
  closeGitDockFn = fn;
}

function closeFileViewerDockIfOpen(): void {
  if (!$fileViewerDocked.get()) return;
  $fileViewerDocked.set(false);
  $dockedFilePath.set(null);
  const fvDock = document.getElementById('file-viewer-dock');
  if (fvDock) fvDock.classList.add('hidden');
  document.getElementById('app')?.classList.remove('file-viewer-docked');
}

function closeGitDockIfOpen(): void {
  if ($gitPanelDocked.get() && closeGitDockFn) {
    closeGitDockFn();
  }
}

export function toggleCommandsDock(sessionId: string): void {
  if ($commandsPanelDocked.get()) {
    closeCommandsDock();
  } else {
    openCommandsDock(sessionId);
  }
}

function openCommandsDock(sessionId: string): void {
  closeFileViewerDockIfOpen();
  closeGitDockIfOpen();

  $commandsPanelDocked.set(true);
  setActionButtonActive('commands', true);

  const dockPanel = document.getElementById('commands-dock');
  const app = document.getElementById('app');
  if (!dockPanel) return;

  dockPanel.classList.remove('hidden');
  app?.classList.add('commands-docked');

  const savedWidth = localStorage.getItem(DOCK_WIDTH_KEY);
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= DOCK_MIN_WIDTH && w <= DOCK_MAX_WIDTH) {
      dockPanel.style.width = w + 'px';
      const terminalsArea = document.querySelector('.terminals-area') as HTMLElement;
      if (terminalsArea) terminalsArea.style.marginRight = w + 'px';
    }
  }

  const body = dockPanel.querySelector('.commands-dock-body') as HTMLElement;
  if (body) {
    body.innerHTML = '';
    renderCommandsPanelInto(body, sessionId);
  }

  requestAnimationFrame(rescaleAllTerminalsImmediate);

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

  log.info(() => 'Commands dock opened');
}

export function closeCommandsDock(): void {
  activeUnsub?.();
  activeUnsub = null;

  $commandsPanelDocked.set(false);
  setActionButtonActive('commands', false);

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

  log.info(() => 'Commands dock closed');
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
