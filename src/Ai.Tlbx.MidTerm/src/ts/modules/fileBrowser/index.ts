/**
 * File Browser Module
 *
 * Tree view + file preview for the Files tab.
 * Renders into the session tab panel created by sessionTabs module.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { addProcessStateListener } from '../process';
import { createTreeView, setTreeRoot, destroyTreeView } from './treeView';
import { renderPreview, clearPreview } from './filePreview';
import { $processStates } from '../../stores';
import { confirmFileNavigation } from '../fileViewer/editState';
import { beginFileOpen, isFileOpenCurrent } from '../fileViewer/loadState';
import { t } from '../i18n';

const log = createLogger('fileBrowser');

const initializedSessions = new Set<string>();
const sessionCwds = new Map<string, string>();
const previewContainers = new Map<string, HTMLElement>();

export function initFileBrowser(): void {
  onTabActivated('files', (sessionId, panel) => {
    ensureFileBrowserForSession(sessionId, panel);
  });

  onTabDeactivated('files', () => {
    // Nothing to clean up on deactivation
  });

  addProcessStateListener((sessionId, state) => {
    const cwd = state.foregroundCwd;
    if (cwd && cwd !== sessionCwds.get(sessionId)) {
      sessionCwds.set(sessionId, cwd);
      if (initializedSessions.has(sessionId)) {
        void setTreeRoot(sessionId, cwd);
      }
    }
  });

  log.info(() => 'File browser initialized');
}

function ensureFileBrowserForSession(sessionId: string, panel: HTMLDivElement): void {
  const treeContainer = panel.querySelector<HTMLElement>('.file-browser-tree');
  const previewContainer = panel.querySelector<HTMLElement>('.file-browser-preview');

  if (!treeContainer) return;
  if (!previewContainer) return;

  if (!initializedSessions.has(sessionId)) {
    initializedSessions.add(sessionId);
    previewContainers.set(sessionId, previewContainer);
    const browser = panel.querySelector<HTMLElement>('.file-browser');
    const detail = panel.querySelector<HTMLElement>('.file-browser-detail');
    let treeScroll = 0;
    let detailScroll: Array<{ element: HTMLElement; top: number; left: number }> = [];
    if (browser && detail) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'file-browser-back';
      back.textContent = `← ${t('fileBrowser.backToFiles')}`;
      back.addEventListener('click', () => {
        detailScroll = [previewContainer, ...previewContainer.querySelectorAll<HTMLElement>('*')]
          .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
          .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
        browser.dataset.filePane = 'tree';
        treeContainer.scrollTop = treeScroll;
        const selected = treeContainer.querySelector<HTMLElement>('.tree-node.selected');
        if (selected) selected.tabIndex = 0;
        selected?.focus({ preventScroll: true });
      });
      detail.insertBefore(back, previewContainer);
    }

    createTreeView(treeContainer, sessionId, async (entry) => {
      const request = beginFileOpen(sessionId);
      const sameFile = previewContainer.dataset.selectedPath === entry.fullPath;
      if (
        (!sameFile && !(await confirmFileNavigation(previewContainer))) ||
        !isFileOpenCurrent(request)
      )
        return false;
      // Reopening the selected file is a presentation change: retain its draft and DOM.
      if (!sameFile) {
        renderPreview(previewContainer, entry, sessionId);
        previewContainer.dataset.selectedPath = entry.fullPath;
        detailScroll = [];
      }
      treeScroll = treeContainer.scrollTop;
      if (browser) browser.dataset.filePane = 'detail';
      requestAnimationFrame(() => {
        for (const position of detailScroll) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
      });
      return true;
    });

    clearPreview(previewContainer);
  }

  const cwd = sessionCwds.get(sessionId) ?? $processStates.get()[sessionId]?.foregroundCwd ?? null;
  if (cwd) {
    sessionCwds.set(sessionId, cwd);
    void setTreeRoot(sessionId, cwd);
  }
}

export function destroyFileBrowser(sessionId: string): void {
  const preview = previewContainers.get(sessionId);
  if (preview) clearPreview(preview);
  previewContainers.delete(sessionId);
  destroyTreeView(sessionId);
  initializedSessions.delete(sessionId);
  sessionCwds.delete(sessionId);
}
