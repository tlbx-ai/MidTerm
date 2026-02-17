/**
 * File Browser Module
 *
 * Tree view + file preview for the Files tab.
 * Renders into the session tab panel created by sessionTabs module.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { $processStates } from '../../stores';
import { createTreeView, setTreeRoot, destroyTreeView } from './treeView';
import { renderPreview, clearPreview } from './filePreview';

const log = createLogger('fileBrowser');

const initializedSessions = new Set<string>();
const sessionCwds = new Map<string, string>();

export function initFileBrowser(): void {
  onTabActivated('files', (sessionId, panel) => {
    ensureFileBrowserForSession(sessionId, panel);
  });

  onTabDeactivated('files', () => {
    // Nothing to clean up on deactivation
  });

  $processStates.subscribe((states) => {
    for (const [sessionId, state] of Object.entries(states)) {
      const cwd = state.foregroundCwd;
      if (cwd && cwd !== sessionCwds.get(sessionId)) {
        sessionCwds.set(sessionId, cwd);
        if (initializedSessions.has(sessionId)) {
          setTreeRoot(sessionId, cwd);
        }
      }
    }
  });

  log.info(() => 'File browser initialized');
}

function ensureFileBrowserForSession(sessionId: string, panel: HTMLDivElement): void {
  const treeContainer = panel.querySelector('.file-browser-tree') as HTMLElement;
  const previewContainer = panel.querySelector('.file-browser-preview') as HTMLElement;

  if (!treeContainer || !previewContainer) return;

  if (!initializedSessions.has(sessionId)) {
    initializedSessions.add(sessionId);

    createTreeView(treeContainer, sessionId, (entry) => {
      renderPreview(previewContainer, entry, sessionId);
    });

    clearPreview(previewContainer);
  }

  const cwd = sessionCwds.get(sessionId);
  if (cwd) {
    setTreeRoot(sessionId, cwd);
  }
}

export function destroyFileBrowser(sessionId: string): void {
  destroyTreeView(sessionId);
  initializedSessions.delete(sessionId);
  sessionCwds.delete(sessionId);
}
