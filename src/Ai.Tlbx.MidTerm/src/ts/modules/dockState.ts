/**
 * Dock State Module
 *
 * Per-session inner dock state tracking. Saves and restores which dock panel
 * (git, commands, file-viewer) is open for each terminal session.
 * Web preview is NOT managed here — it has its own per-session state in webSessionState.ts.
 */

import {
  $activeSessionId,
  $gitPanelDocked,
  $commandsPanelDocked,
  $fileViewerDocked,
  $dockedFilePath,
} from '../stores';
import { openGitDock, closeGitDock } from './git/gitDock';
import { openCommandsDock, closeCommandsDock } from './commands/dock';
import { closeFileViewerDock, openFileViewerDock } from './fileViewer';

type InnerDock = 'none' | 'git' | 'commands' | 'file-viewer';

interface SessionDockInfo {
  innerDock: InnerDock;
  filePath: string | null;
}

const sessionDocks = new Map<string, SessionDockInfo>();

function readCurrentDock(): SessionDockInfo {
  if ($gitPanelDocked.get()) return { innerDock: 'git', filePath: null };
  if ($commandsPanelDocked.get()) return { innerDock: 'commands', filePath: null };
  if ($fileViewerDocked.get()) return { innerDock: 'file-viewer', filePath: $dockedFilePath.get() };
  return { innerDock: 'none', filePath: null };
}

function closeCurrentDock(): void {
  if ($gitPanelDocked.get()) closeGitDock();
  else if ($commandsPanelDocked.get()) closeCommandsDock();
  else if ($fileViewerDocked.get()) closeFileViewerDock();
}

function restoreDock(sessionId: string, info: SessionDockInfo): void {
  switch (info.innerDock) {
    case 'git':
      openGitDock(sessionId);
      break;
    case 'commands':
      openCommandsDock(sessionId);
      break;
    case 'file-viewer':
      if (info.filePath) openFileViewerDock(info.filePath);
      break;
  }
}

export function initDockState(): void {
  let previousId: string | null = null;

  $activeSessionId.subscribe((newId) => {
    if (previousId === newId) return;
    const oldId = previousId;
    previousId = newId;

    if (oldId) {
      sessionDocks.set(oldId, readCurrentDock());
    }

    closeCurrentDock();

    if (newId) {
      const saved = sessionDocks.get(newId);
      if (saved && saved.innerDock !== 'none') {
        restoreDock(newId, saved);
      }
    }
  });
}

export function removeSessionDockState(sessionId: string): void {
  sessionDocks.delete(sessionId);
}
