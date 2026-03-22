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
  initWebPanel,
  loadPreview,
  renderPreviewTabs,
  restoreLastUrl,
  setPreviewTabSelectHandler,
} from './webPanel';
import {
  closeDetachedIfOwnedBy,
  dockBack,
  initDetach,
  isDetachedOpenForSession,
} from './webDetach';
import { listWebPreviewSessions } from './webApi';
import {
  getSessionPreview,
  getSessionSelectedPreviewName,
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

export { closeWebPreviewDock } from './webDock';
export { adjustInnerDockPositions, updateAllDockMargins } from './webDock';
