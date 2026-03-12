/**
 * Web Preview Detach
 *
 * Handles detaching named web previews to chromeless popup windows
 * and docking them back into the main panel.
 */

import { $activeSessionId, $webPreviewDetached, $webPreviewUrl } from '../../stores';
import { hideDetachedPlaceholder, loadPreview } from './webPanel';
import { createLogger } from '../logging';
import {
  getActivePreviewName,
  getSessionPreview,
  setSessionDockedClient,
  setSessionMode,
  setSessionSelectedPreviewName,
  setSessionUrl,
} from './webSessionState';
import { createBrowserPreviewClient } from './webApi';
import { isDevMode } from '../sidebar/voiceSection';

const log = createLogger('webDetach');

const popups = new Map<string, Window>();
const channels = new Map<string, BroadcastChannel>();

function popupKey(sessionId: string, previewName: string): string {
  return `${sessionId}::${previewName}`;
}

function channelName(sessionId: string, previewName: string): string {
  return `midterm-web-preview-${sessionId}-${previewName}`;
}

function getPopupKeysForSession(sessionId: string): string[] {
  const prefix = `${sessionId}::`;
  return Array.from(popups.keys()).filter((key) => key.startsWith(prefix));
}

/** Initialize the detach system: wire up detach and dock-back buttons. */
export function initDetach(): void {
  document.getElementById('web-preview-detach')?.addEventListener('click', () => {
    void detachPreview();
  });
  document.getElementById('web-preview-dock-back')?.addEventListener('click', () => {
    dockBack();
  });
}

function handleMessage(
  e: MessageEvent<{ type: string; sessionId?: string; previewName?: string; url?: string }>,
): void {
  const { type, sessionId, previewName, url } = e.data;
  const targetPreviewName = previewName ?? 'default';

  if (type === 'navigation' && sessionId && typeof url === 'string') {
    setSessionUrl(sessionId, targetPreviewName, url);
    if (sessionId === $activeSessionId.get() && targetPreviewName === getActivePreviewName()) {
      $webPreviewUrl.set(url);
    }
    return;
  }

  if (type === 'dock-back' || type === 'popup-closed') {
    dockBack(sessionId ?? undefined, targetPreviewName);
  }
}

/** Open a named web preview in a chromeless popup window and hide the dock panel. */
export async function detachPreview(sessionId?: string, previewName?: string): Promise<void> {
  const targetSessionId = sessionId ?? $activeSessionId.get();
  if (!targetSessionId) {
    return;
  }

  const targetPreviewName = setSessionSelectedPreviewName(targetSessionId, previewName);
  const key = popupKey(targetSessionId, targetPreviewName);
  const existing = popups.get(key);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }

  const preview = getSessionPreview(targetSessionId, targetPreviewName);
  const url =
    preview?.url ??
    (targetSessionId === $activeSessionId.get() && targetPreviewName === getActivePreviewName()
      ? $webPreviewUrl.get()
      : null);

  const previewClient = await createBrowserPreviewClient(targetSessionId, targetPreviewName);
  if (!previewClient) {
    log.warn(
      () => `Failed to create detached browser client for ${targetSessionId}/${targetPreviewName}`,
    );
    return;
  }

  setSessionDockedClient(targetSessionId, targetPreviewName, previewClient);

  const popupUrl =
    '/web-preview-popup.html' +
    `?session=${encodeURIComponent(targetSessionId)}` +
    `&preview=${encodeURIComponent(targetPreviewName)}` +
    `&routeKey=${encodeURIComponent(previewClient.routeKey)}` +
    `&previewId=${encodeURIComponent(previewClient.previewId)}` +
    `&previewToken=${encodeURIComponent(previewClient.previewToken)}` +
    (previewClient.origin ? `&origin=${encodeURIComponent(previewClient.origin)}` : '') +
    (isDevMode() ? '&sandbox=1' : '') +
    (url ? `&url=${encodeURIComponent(url)}` : '');

  const popup = window.open(
    popupUrl,
    `midterm-web-preview-${targetSessionId}-${targetPreviewName}`,
    'popup,width=1280,height=900,menubar=no,toolbar=no,location=no,status=no',
  );

  if (!popup) {
    return;
  }

  closePopupForPreview(targetSessionId, targetPreviewName);
  popups.set(key, popup);

  const ch = new BroadcastChannel(channelName(targetSessionId, targetPreviewName));
  ch.onmessage = handleMessage;
  channels.set(key, ch);

  setSessionMode(targetSessionId, targetPreviewName, 'detached');

  if (targetSessionId === $activeSessionId.get() && targetPreviewName === getActivePreviewName()) {
    $webPreviewDetached.set(true);
    const dockPanel = document.getElementById('web-preview-dock');
    if (dockPanel) {
      dockPanel.classList.add('hidden');
      dockPanel.style.width = '';
    }
  }

  log.info(() => `Web preview detached to popup for ${targetSessionId}/${targetPreviewName}`);
}

/** Close a detached popup and restore the named web preview into the dock panel. */
export function dockBack(sessionId?: string, previewName?: string): void {
  const targetSessionId = sessionId ?? $activeSessionId.get();
  if (!targetSessionId) {
    return;
  }

  const targetPreviewName =
    previewName ??
    (targetSessionId === $activeSessionId.get() ? getActivePreviewName() : undefined) ??
    'default';

  closePopupForPreview(targetSessionId, targetPreviewName);
  setSessionMode(targetSessionId, targetPreviewName, 'docked');

  if (targetSessionId === $activeSessionId.get() && targetPreviewName === getActivePreviewName()) {
    $webPreviewDetached.set(false);
    hideDetachedPlaceholder();
    const dockPanel = document.getElementById('web-preview-dock');
    if (dockPanel) {
      dockPanel.classList.remove('hidden');
    }
    void loadPreview();
    log.info(() => `Web preview docked back for ${targetSessionId}/${targetPreviewName}`);
  }
}

/** Close all detached popup windows and release their channels. */
export function cleanupDetach(): void {
  for (const key of Array.from(popups.keys())) {
    const [sessionId, previewName] = key.split('::', 2);
    if (sessionId && previewName) {
      closePopupForPreview(sessionId, previewName);
    }
  }
}

/** Close all detached popups owned by a terminal session. */
export function closeDetachedIfOwnedBy(sessionId: string | null): void {
  if (!sessionId) {
    return;
  }

  for (const key of getPopupKeysForSession(sessionId)) {
    const previewName = key.slice(`${sessionId}::`.length);
    closePopupForPreview(sessionId, previewName);
  }
}

/** Check whether a detached popup is open for a session or a specific named preview. */
export function isDetachedOpenForSession(
  sessionId: string | null,
  previewName?: string | null,
): boolean {
  if (!sessionId) {
    return false;
  }

  if (previewName) {
    const popup = popups.get(popupKey(sessionId, previewName));
    return !!popup && !popup.closed;
  }

  return getPopupKeysForSession(sessionId).some((key) => {
    const popup = popups.get(key);
    return !!popup && !popup.closed;
  });
}

function closePopupForPreview(sessionId: string, previewName: string): void {
  const key = popupKey(sessionId, previewName);
  const popup = popups.get(key);
  if (popup && !popup.closed) {
    popup.close();
  }
  popups.delete(key);

  const channel = channels.get(key);
  if (channel) {
    channel.close();
    channels.delete(key);
  }
}
