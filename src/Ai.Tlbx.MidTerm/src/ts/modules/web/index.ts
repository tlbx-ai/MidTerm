/**
 * Web Preview Module
 *
 * In-app website preview with reverse proxy.
 * Shows a dockable iframe panel that can be detached to a popup window.
 */

import { setWebClickHandler } from '../sessionTabs';
import { $activeSessionId, $webPreviewDetached, $webPreviewUrl, $sessionList } from '../../stores';
import {
  toggleWebPreviewDock,
  closeWebPreviewDock,
  setupWebPreviewDockResize,
  openWebPreviewDock,
  applyWebPreviewHiddenState,
  suspendWebPreviewDock,
  hideWebPreviewDockForDetach,
  initViewportReset,
} from './webDock';
import { initWebPanel, loadPreview, restoreLastUrl, getLoadedUrl } from './webPanel';
import { closeDetachedIfOwnedBy, initDetach, isDetachedOpenForSession } from './webDetach';
import { setWebPreviewTarget } from './webApi';
import { getSessionState, removeSessionState } from './webSessionState';

export function initWebPreview(): void {
  setWebClickHandler(() => {
    toggleWebPreviewDock();
  });

  initWebPanel();
  initDetach();
  initViewportReset();

  document.getElementById('web-preview-close')?.addEventListener('click', closeWebPreviewDock);
  setupWebPreviewDockResize();

  let syncToken = 0;
  let knownSessionIds = new Set<string>();

  $activeSessionId.subscribe((sessionId) => {
    void syncActiveSessionPreview(++syncToken, sessionId);
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

  async function syncActiveSessionPreview(token: number, sessionId: string | null): Promise<void> {
    const state = getSessionState(sessionId);

    if (!sessionId || !state || !state.url || state.mode === 'hidden') {
      $webPreviewDetached.set(isDetachedOpenForSession(sessionId));
      if (getLoadedUrl()) {
        suspendWebPreviewDock();
      } else {
        applyWebPreviewHiddenState();
      }
      return;
    }

    if (state.mode === 'docked') {
      const loaded = getLoadedUrl();
      if (loaded && loaded === state.url) {
        $webPreviewDetached.set(false);
        $webPreviewUrl.set(state.url);
        openWebPreviewDock();
        restoreLastUrl();
        return;
      }

      const result = await setWebPreviewTarget(state.url);
      if (token !== syncToken) return;
      if (!result?.active) {
        $webPreviewDetached.set(isDetachedOpenForSession(sessionId));
        applyWebPreviewHiddenState();
        return;
      }

      $webPreviewUrl.set(state.url);
      $webPreviewDetached.set(false);
      openWebPreviewDock();
      restoreLastUrl();
      loadPreview();
      return;
    }

    const result = await setWebPreviewTarget(state.url);
    if (token !== syncToken) return;
    if (!result?.active) {
      $webPreviewDetached.set(isDetachedOpenForSession(sessionId));
      applyWebPreviewHiddenState();
      return;
    }

    $webPreviewUrl.set(state.url);
    $webPreviewDetached.set(true);
    hideWebPreviewDockForDetach();
  }
}

export { closeWebPreviewDock } from './webDock';
export { adjustInnerDockPositions, updateAllDockMargins } from './webDock';
