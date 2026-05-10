/**
 * Web Preview Module
 *
 * In-app website preview with session-scoped, named browser contexts.
 */

import { setWebClickHandler } from '../sessionTabs';
import { $activeSessionId, $webPreviewDetached, $webPreviewUrl, $sessionList } from '../../stores';
import {
  toggleWebPreviewDock,
  closeWebPreviewDock,
  setupWebPreviewDockResize,
  openWebPreviewDock,
  applyWebPreviewHiddenState,
  hideWebPreviewDockForDetach,
  initViewportReset,
} from './webDock';
import {
  destroyPreviewFrame,
  initWebPanel,
  loadPreview,
  renderPreviewTabs,
  restoreLastUrl,
  setPreviewTabCloseHandler,
  setPreviewTabSelectHandler,
} from './webPanel';
import {
  closeDetachedPreview,
  closeDetachedIfOwnedBy,
  dockBack,
  initDetach,
  isDetachedOpenForSession,
} from './webDetach';
import { clearWebPreviewTarget, deleteWebPreviewSession, listWebPreviewSessions } from './webApi';
import {
  DEFAULT_PREVIEW_NAME,
  getSessionPreview,
  getSessionSelectedPreviewName,
  removeSessionPreview,
  removeSessionState,
  setSessionMode,
  setSessionSelectedPreviewName,
  syncSessionPreviews,
} from './webSessionState';

let syncToken = 0;

export function initWebPreview(): void {
  setWebClickHandler(() => {
    toggleWebPreviewDock();
  });

  initWebPanel();
  initDetach();
  initViewportReset();
  setPreviewTabSelectHandler((previewName) => {
    void selectActivePreview(previewName);
  });
  setPreviewTabCloseHandler((previewName) => {
    void closeActivePreview(previewName);
  });

  document.getElementById('web-preview-close')?.addEventListener('click', closeWebPreviewDock);
  setupWebPreviewDockResize();

  let knownSessionIds = new Set<string>();
  $activeSessionId.subscribe(() => {
    void syncActiveWebPreview();
  });

  $sessionList.subscribe((sessions) => {
    const ids = new Set(sessions.map((s) => s.id).filter(Boolean));
    for (const oldId of knownSessionIds) {
      if (!ids.has(oldId)) {
        closeDetachedIfOwnedBy(oldId);
        removeSessionState(oldId);
      }
    }
    knownSessionIds = ids;
  });
}

/** Re-sync the active session's selected web preview with server-side preview state. */
export async function syncActiveWebPreview(): Promise<void> {
  const token = ++syncToken;
  const sessionId = $activeSessionId.get();
  renderPreviewTabs();

  if (!sessionId) {
    $webPreviewDetached.set(false);
    $webPreviewUrl.set(null);
    applyWebPreviewHiddenState();
    renderPreviewTabs();
    return;
  }

  const previews = await listWebPreviewSessions(sessionId);
  if (token !== syncToken) {
    return;
  }
  if (previews === null) {
    return;
  }

  syncSessionPreviews(sessionId, previews);
  renderPreviewTabs();

  const previewName = getSessionSelectedPreviewName(sessionId);
  const preview = getSessionPreview(sessionId, previewName);
  const detached = isDetachedOpenForSession(sessionId, previewName);

  $webPreviewUrl.set(preview?.url ?? null);

  if (!preview || preview.mode === 'hidden') {
    $webPreviewDetached.set(false);
    applyWebPreviewHiddenState();
    renderPreviewTabs();
    return;
  }

  if (preview.mode === 'detached' && detached) {
    $webPreviewDetached.set(true);
    hideWebPreviewDockForDetach();
    renderPreviewTabs();
    return;
  }

  if (preview.mode === 'detached' && !detached) {
    setSessionMode(sessionId, previewName, 'docked');
  }

  $webPreviewDetached.set(false);
  openWebPreviewDock();
  restoreLastUrl();
  renderPreviewTabs();
  await loadPreview();
}

/** Select a named preview for the active session and show it in the dock. */
export async function selectActivePreview(previewName: string): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    return;
  }

  const normalized = setSessionSelectedPreviewName(sessionId, previewName);
  if (isDetachedOpenForSession(sessionId, normalized)) {
    dockBack(sessionId, normalized);
  } else {
    setSessionMode(sessionId, normalized, 'docked');
  }

  renderPreviewTabs();
  await syncActiveWebPreview();
}

export async function closeActivePreview(previewName: string): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    return;
  }

  const normalized = previewName.trim() || DEFAULT_PREVIEW_NAME;
  if (normalized === DEFAULT_PREVIEW_NAME) {
    closeDetachedPreview(sessionId, normalized);
    destroyPreviewFrame(sessionId, normalized);
    await clearWebPreviewTarget(sessionId, normalized);
    removeSessionPreview(sessionId, normalized);
    renderPreviewTabs();
    await syncActiveWebPreview();
    return;
  }

  const deleted = await deleteWebPreviewSession(sessionId, normalized);
  if (!deleted) {
    return;
  }

  closeDetachedPreview(sessionId, normalized);
  destroyPreviewFrame(sessionId, normalized);
  removeSessionPreview(sessionId, normalized);
  renderPreviewTabs();
  await syncActiveWebPreview();
}

export { closeWebPreviewDock } from './webDock';
export { adjustInnerDockPositions, updateAllDockMargins } from './webDock';
