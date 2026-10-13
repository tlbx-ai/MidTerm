/**
 * File Browser Module
 *
 * Tree view + file preview for the Files tab.
 * Renders into the session tab panel created by sessionTabs module.
 */

import { createLogger } from '../logging';
import { getActiveTab, onTabActivated, onTabDeactivated } from '../sessionTabs';
import { addProcessStateListener } from '../process';
import {
  applyTreeRoot,
  applyTreeVisibility,
  createTreeView,
  destroyTreeView,
  getTreeSelection,
  setTreeSelection,
  getTreeEntry,
} from './treeView';
import { renderPreview, clearPreview } from './filePreview';
import { $activeSessionId, $processStates } from '../../stores';
import { confirmFileNavigation, filePathAffected } from '../fileViewer/editState';
import { beginFileOpen, isFileOpenCurrent } from '../fileViewer/loadState';
import { t } from '../i18n';
import { BrowserNavigation } from './navigation';
import type { FileTreeEntry } from './treeApi';
import { resizeFilePane } from '../fileViewer/paneResize';

const log = createLogger('fileBrowser');

const initializedSessions = new Set<string>();
const sessionCwds = new Map<string, string>();
const previewContainers = new Map<string, HTMLElement>();
const navigators = new Map<string, BrowserNavigation>();
const paneResizers = new Map<string, ReturnType<typeof resizeFilePane>>();

export function initFileBrowser(): void {
  onTabActivated('files', (sessionId, panel) => {
    ensureFileBrowserForSession(sessionId, panel);
    navigators.get(sessionId)?.setActive(sessionId === $activeSessionId.get());
  });

  onTabDeactivated('files', (sessionId) => {
    navigators.get(sessionId)?.setActive(false);
  });
  $activeSessionId.listen((active) => {
    navigators.forEach((navigation, sessionId) => {
      navigation.setActive(sessionId === active && getActiveTab(sessionId) === 'files');
    });
  });

  addProcessStateListener((sessionId, state) => {
    const cwd = state.foregroundCwd;
    if (cwd && cwd !== sessionCwds.get(sessionId)) {
      sessionCwds.set(sessionId, cwd);
      if (initializedSessions.has(sessionId)) {
        navigators.get(sessionId)?.setCwd(cwd);
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
    setupTreeResize(panel, treeContainer, sessionId);
    let treeScroll = 0;
    let detailScroll: Array<{ element: HTMLElement; top: number; left: number }> = [];
    if (browser && detail) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'file-browser-back';
      back.textContent = '←';
      back.title = t('fileBrowser.backToFiles');
      back.setAttribute('aria-label', back.title);
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

    const selectFile = async (entry: FileTreeEntry, focus = false): Promise<boolean> => {
      navigators.get(sessionId)?.cancelPending();
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
      if (focus) {
        previewContainer.tabIndex = -1;
        previewContainer.setAttribute('role', 'region');
        previewContainer.setAttribute('aria-label', t('fileViewer.modePreview'));
        previewContainer.focus({ preventScroll: true });
      }
      requestAnimationFrame(() => {
        for (const position of detailScroll) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
      });
      return true;
    };
    createTreeView(
      treeContainer,
      sessionId,
      selectFile,
      (entry) => {
        void navigators.get(sessionId)?.navigate(entry.fullPath);
      },
      async (result) => {
        const path = previewContainer.dataset.selectedPath;
        await navigators.get(sessionId)?.refresh();
        if (previewContainer.dataset.selectedPath !== path) return;
        if (!path || !['rename', 'move', 'delete'].includes(result.action)) return;
        const changed = result.items.find(
          (item) => item.success && item.sourcePath && filePathAffected(path, [item.sourcePath]),
        );
        if (!changed) return;
        clearPreview(previewContainer);
        delete previewContainer.dataset.selectedPath;
        const entry = changed.path ? getTreeEntry(sessionId, changed.path) : undefined;
        if (entry && !entry.isDirectory) {
          setTreeSelection(sessionId, entry.fullPath);
          await selectFile(entry);
        } else if (browser) browser.dataset.filePane = 'tree';
      },
    );

    if (browser) {
      browser.dataset.filePane = 'tree';
      const navigation = new BrowserNavigation(sessionId, {
        refilter: (path, data, signal) => applyTreeVisibility(sessionId, path, data, signal),
        confirm: () => confirmFileNavigation(previewContainer),
        file: async (entry) => {
          if (!(await selectFile(entry))) return false;
          setTreeSelection(sessionId, entry.fullPath);
          return true;
        },
        apply: (path, data) => {
          applyTreeRoot(sessionId, path, data);
          clearPreview(previewContainer);
          delete previewContainer.dataset.selectedPath;
          const selected = getTreeSelection(sessionId);
          if (selected) {
            renderPreview(previewContainer, selected, sessionId);
            previewContainer.dataset.selectedPath = selected.fullPath;
          }
          detailScroll = [];
          browser.dataset.filePane = 'tree';
        },
      });
      navigators.set(sessionId, navigation);
      browser.prepend(navigation.root);
    }

    clearPreview(previewContainer);
  }

  const cwd = sessionCwds.get(sessionId) ?? $processStates.get()[sessionId]?.foregroundCwd ?? null;
  if (cwd) {
    sessionCwds.set(sessionId, cwd);
    const navigator = navigators.get(sessionId);
    if (navigator && (navigator.hasLocation || !navigator.busy)) {
      navigator.setCwd(cwd);
    }
  }
}

function setupTreeResize(panel: HTMLElement, tree: HTMLElement, sessionId: string): void {
  const layout = panel.querySelector<HTMLElement>('.file-browser-layout');
  if (!layout) return;
  const grip = document.createElement('div');
  grip.className = 'file-pane-resize-grip';
  grip.setAttribute('aria-label', t('fileBrowser.resizeTree'));
  tree.id = `file-tree-${sessionId}`;
  grip.setAttribute('aria-controls', tree.id);
  tree.after(grip);
  paneResizers.set(
    sessionId,
    resizeFilePane({
      panel: tree,
      grip,
      key: `tlbx-file-tree-width:${sessionId}`,
      defaultWidth: 280,
      direction: 1,
      bounds: () => ({
        min: 220,
        max: Math.max(
          220,
          Math.min(900, layout.clientWidth - 260 - (parseFloat(getComputedStyle(grip).width) || 8)),
        ),
        enabled: layout.clientWidth > 768,
      }),
      observe: [layout, tree],
    }),
  );
}

export function destroyFileBrowser(sessionId: string): void {
  paneResizers.get(sessionId)?.dispose();
  paneResizers.delete(sessionId);
  navigators.get(sessionId)?.dispose();
  navigators.delete(sessionId);
  const preview = previewContainers.get(sessionId);
  if (preview) clearPreview(preview);
  previewContainers.delete(sessionId);
  destroyTreeView(sessionId);
  initializedSessions.delete(sessionId);
  sessionCwds.delete(sessionId);
}
