/**
 * Git Dock
 *
 * Dock logic for snapping the git panel to the right sidebar.
 */

import {
  $gitPanelDocked,
  $activeSessionId,
  $fileViewerDocked,
  $commandsPanelDocked,
} from '../../stores';
import { handleDockLayoutChange } from '../terminal/scaling';
import { setActionButtonActive } from '../sessionTabs';
import {
  refreshGitPanel,
  renderGitPanelInto,
  showCommitInGitPanel,
  suspendGitPanel,
} from './gitPanel';
import { subscribeToSession } from './gitChannel';
import { closeCommandsDock } from '../commands/dock';
import { adjustInnerDockPositions, updateAllDockMargins } from '../web';
import { createLogger } from '../logging';
import { requestCloseFileViewerDock } from '../fileViewer';
import { resizeFilePane } from '../fileViewer/paneResize';
import { t } from '../i18n';
import { createGitDockFocus } from './gitDockFocus';

const log = createLogger('gitDock');

const DOCK_MIN_WIDTH = 250;
const DOCK_MAX_WIDTH = 600;
const DOCK_WIDTH_KEY = 'mt-git-dock-width';

let activeUnsub: (() => void) | null = null;
let currentDockSessionId: string | null = null;
let currentDockRepoRoot: string | undefined;
let dockResize: ReturnType<typeof resizeFilePane> | null = null;
let dockFocus: ReturnType<typeof createGitDockFocus> | null = null;

function closeCommandsDockIfOpen(): void {
  if ($commandsPanelDocked.get()) {
    closeCommandsDock();
  }
}

export function toggleGitDock(sessionId: string, repoRoot?: string): void {
  if ($gitPanelDocked.get()) {
    if (currentDockSessionId === sessionId && currentDockRepoRoot === repoRoot) {
      closeGitDock();
    } else {
      openGitDock(sessionId, repoRoot);
    }
  } else {
    openGitDock(sessionId, repoRoot);
  }
}

export function openGitDock(sessionId: string, repoRoot?: string): void {
  void openGitDockAfterFileDecision(sessionId, repoRoot);
}

async function openGitDockAfterFileDecision(
  sessionId: string,
  repoRoot?: string,
): Promise<boolean> {
  const activeSessionId = $activeSessionId.get();
  if ($fileViewerDocked.get() && !(await requestCloseFileViewerDock())) return false;
  if (activeSessionId !== $activeSessionId.get()) return false;
  closeCommandsDockIfOpen();

  if (!$gitPanelDocked.get()) dockFocus?.remember();

  $gitPanelDocked.set(true);
  setActionButtonActive('git', true);
  currentDockSessionId = sessionId;
  currentDockRepoRoot = repoRoot;

  const dockPanel = document.getElementById('git-dock');
  const app = document.getElementById('app');
  if (!dockPanel) return false;

  dockPanel.classList.remove('hidden');
  app?.classList.add('git-docked');

  dockResize?.refresh();

  const body = dockPanel.querySelector<HTMLElement>('.git-dock-body');
  if (body) {
    subscribeToSession(sessionId);
    void renderGitPanelInto(body, sessionId, repoRoot);
  }

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();

  dockFocus?.refresh();
  dockFocus?.enter();

  activeUnsub?.();
  activeUnsub = $activeSessionId.subscribe((newId) => {
    if (!$gitPanelDocked.get() || !newId || newId === currentDockSessionId) return;
    currentDockSessionId = newId;
    currentDockRepoRoot = undefined;
    const dockBody = document
      .getElementById('git-dock')
      ?.querySelector('.git-dock-body') as HTMLElement | null;
    if (dockBody) {
      subscribeToSession(newId);
      void renderGitPanelInto(dockBody, newId);
    }
  });

  log.info(() => 'Git dock opened');
  return true;
}

export async function openGitCommitDock(
  sessionId: string,
  hash: string,
  repoRoot?: string,
): Promise<void> {
  if (!(await openGitDockAfterFileDecision(sessionId, repoRoot))) return;
  await showCommitInGitPanel(sessionId, hash, repoRoot);
}

export function closeGitDock(): void {
  activeUnsub?.();
  activeUnsub = null;
  currentDockSessionId = null;
  currentDockRepoRoot = undefined;

  $gitPanelDocked.set(false);
  setActionButtonActive('git', false);

  const dockPanel = document.getElementById('git-dock');
  const app = document.getElementById('app');

  if (dockPanel) {
    const body = dockPanel.querySelector<HTMLElement>('.git-dock-body');
    if (body) suspendGitPanel(body);
    dockPanel.classList.add('hidden');
    dockPanel.style.width = '';
  }
  app?.classList.remove('git-docked');

  adjustInnerDockPositions();
  updateAllDockMargins();
  handleDockLayoutChange();

  log.info(() => 'Git dock closed');
  dockFocus?.restore();
}

export function setupGitDockResize(): void {
  const dockPanel = document.getElementById('git-dock');
  const gripEl = dockPanel?.querySelector('.git-dock-resize-grip') as HTMLElement | null;
  const refreshBtn = document.getElementById('git-dock-refresh');
  const closeBtn = document.getElementById('git-dock-close');
  if (!dockPanel || !gripEl) return;
  dockFocus ??= createGitDockFocus(dockPanel, closeGitDock);
  dockPanel.setAttribute('aria-label', 'Git');

  dockResize?.dispose();
  gripEl.setAttribute('aria-label', t('git.resizeDock'));
  dockResize = resizeFilePane({
    panel: dockPanel,
    grip: gripEl,
    key: DOCK_WIDTH_KEY,
    defaultWidth: 400,
    widthProperty: '--git-pane-width',
    direction: -1,
    bounds: () => {
      const overlay = window.innerWidth <= 768;
      dockPanel.dataset.gitOverlay = String(overlay);
      return { min: DOCK_MIN_WIDTH, max: DOCK_MAX_WIDTH, enabled: !overlay };
    },
    observe: [document.documentElement],
    changed: () => {
      adjustInnerDockPositions();
      updateAllDockMargins();
      handleDockLayoutChange();
      dockFocus?.refresh();
    },
  });

  refreshBtn?.addEventListener('click', () => {
    if (!$gitPanelDocked.get() || !currentDockSessionId) return;
    void refreshGitPanel(currentDockSessionId, currentDockRepoRoot);
  });

  closeBtn?.addEventListener('click', () => {
    closeGitDock();
  });
}
