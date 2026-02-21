/**
 * Web Preview Module
 *
 * In-app website preview with reverse proxy.
 * Shows a dockable iframe panel that can be detached to a popup window.
 */

import { setWebClickHandler } from '../sessionTabs';
import { $activeSessionId, $webPreviewUrl, $sessionList } from '../../stores';
import {
  toggleWebPreviewDock,
  closeWebPreviewDock,
  setupWebPreviewDockResize,
  openWebPreviewDock,
  applyWebPreviewHiddenState,
  hideWebPreviewDockForDetach,
} from './webDock';
import { initWebPanel, loadPreview, restoreLastUrl } from './webPanel';
import { closeDetachedIfOwnedBy, initDetach } from './webDetach';
import { setWebPreviewTarget } from './webApi';
import { getSessionState, removeSessionState, setSessionMode } from './webSessionState';

export function initWebPreview(): void {
  setWebClickHandler(() => {
    toggleWebPreviewDock();
  });

  initWebPanel();
  initDetach();

  document.getElementById('web-preview-close')?.addEventListener('click', closeWebPreviewDock);
  setupWebPreviewDockResize();

  let previousActiveSessionId: string | null = null;
  let syncToken = 0;
  let knownSessionIds = new Set<string>();

  $activeSessionId.subscribe((sessionId) => {
    if (previousActiveSessionId && previousActiveSessionId !== sessionId) {
      closeDetachedIfOwnedBy(previousActiveSessionId);
      const prevState = getSessionState(previousActiveSessionId);
      if (prevState?.mode === 'detached') {
        setSessionMode(previousActiveSessionId, 'hidden');
      }
    }

    previousActiveSessionId = sessionId;
    void syncActiveSessionPreview(++syncToken, sessionId);
  });

  $sessionList.subscribe((sessions) => {
    const ids = new Set(sessions.map((s) => s.id).filter(Boolean) as string[]);
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
      applyWebPreviewHiddenState();
      return;
    }

    const result = await setWebPreviewTarget(state.url);
    if (token !== syncToken) return;
    if (!result?.active) {
      applyWebPreviewHiddenState();
      return;
    }

    $webPreviewUrl.set(state.url);
    if (state.mode === 'docked') {
      openWebPreviewDock();
      restoreLastUrl();
      loadPreview();
    } else {
      hideWebPreviewDockForDetach();
    }
  }
}

export { closeWebPreviewDock } from './webDock';
export { adjustInnerDockPositions, updateAllDockMargins } from './webDock';
