/**
 * Web Preview Detach
 *
 * Handles detaching the web preview to a chromeless popup window
 * and docking it back. Uses per-session BroadcastChannels for communication.
 * Multiple sessions can each have their own detached popup simultaneously.
 */

import { $activeSessionId, $webPreviewDetached, $webPreviewUrl } from '../../stores';
import { hideDetachedPlaceholder, loadPreview } from './webPanel';
import { createLogger } from '../logging';
import { getActiveUrl, setActiveMode, setSessionMode, setSessionUrl } from './webSessionState';
import { createBrowserPreviewClient } from './webApi';

const log = createLogger('webDetach');

const popups = new Map<string, Window>();
const channels = new Map<string, BroadcastChannel>();

function channelName(sessionId: string): string {
  return `midterm-web-preview-${sessionId}`;
}

/** Initialize the detach system: wire up detach/dock-back buttons. */
export function initDetach(): void {
  document.getElementById('web-preview-detach')?.addEventListener('click', () => {
    void detachPreview();
  });
  document.getElementById('web-preview-dock-back')?.addEventListener('click', () => {
    dockBack();
  });
}

function handleMessage(e: MessageEvent<{ type: string; sessionId?: string; url?: string }>): void {
  const { type, sessionId, url } = e.data;
  if (type === 'navigation' && sessionId && typeof url === 'string') {
    setSessionUrl(sessionId, url);
    if (sessionId === $activeSessionId.get()) {
      $webPreviewUrl.set(url);
    }
    return;
  }

  if (type === 'dock-back' || type === 'popup-closed') {
    dockBack(sessionId ?? undefined);
  }
}

/** Open the web preview in a chromeless popup window and hide the dock panel. */
export async function detachPreview(): Promise<void> {
  const activeSessionId = $activeSessionId.get();
  if (!activeSessionId) return;

  const existing = popups.get(activeSessionId);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }

  const url = getActiveUrl() ?? $webPreviewUrl.get();
  const previewClient = await createBrowserPreviewClient(activeSessionId);
  if (!previewClient) {
    log.warn(() => `Failed to create detached browser client for session ${activeSessionId}`);
    return;
  }

  const popupUrl =
    '/web-preview-popup.html' +
    `?session=${encodeURIComponent(activeSessionId)}` +
    `&previewId=${encodeURIComponent(previewClient.previewId)}` +
    `&previewToken=${encodeURIComponent(previewClient.previewToken)}` +
    (url ? `&url=${encodeURIComponent(url)}` : '');

  const popup = window.open(
    popupUrl,
    `midterm-web-preview-${activeSessionId}`,
    'popup,width=1280,height=900,menubar=no,toolbar=no,location=no,status=no',
  );

  if (popup) {
    popups.set(activeSessionId, popup);

    const ch = new BroadcastChannel(channelName(activeSessionId));
    ch.onmessage = handleMessage;
    channels.set(activeSessionId, ch);

    setActiveMode('detached');
    $webPreviewDetached.set(true);
    const dockPanel = document.getElementById('web-preview-dock');
    if (dockPanel) {
      dockPanel.classList.add('hidden');
      dockPanel.style.width = '';
    }
    log.info(() => `Web preview detached to popup for session ${activeSessionId}`);
  }
}

/** Close the detached popup and restore the web preview back into the dock panel. */
export function dockBack(sessionId?: string): void {
  const targetId = sessionId ?? $activeSessionId.get();
  if (!targetId) return;

  closePopupForSession(targetId);
  setSessionMode(targetId, 'docked');

  const activeSessionId = $activeSessionId.get();
  if (targetId === activeSessionId) {
    $webPreviewDetached.set(false);
    hideDetachedPlaceholder();
    const dockPanel = document.getElementById('web-preview-dock');
    if (dockPanel) {
      dockPanel.classList.remove('hidden');
    }
    void loadPreview();
    log.info(() => 'Web preview docked back');
  }
}

/** Close the detached popup and release all BroadcastChannels (page unload). */
export function cleanupDetach(): void {
  for (const [id] of popups) {
    closePopupForSession(id);
  }
}

/** Close the detached popup if it was opened by the given session. */
export function closeDetachedIfOwnedBy(sessionId: string | null): void {
  if (!sessionId) return;
  closePopupForSession(sessionId);
}

/** Check whether a detached popup is currently open for a specific session. */
export function isDetachedOpenForSession(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const popup = popups.get(sessionId);
  return !!popup && !popup.closed;
}

function closePopupForSession(sessionId: string): void {
  const popup = popups.get(sessionId);
  if (popup && !popup.closed) {
    popup.close();
  }
  popups.delete(sessionId);

  const ch = channels.get(sessionId);
  if (ch) {
    ch.close();
    channels.delete(sessionId);
  }
}
