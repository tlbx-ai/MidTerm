/**
 * Web Preview Detach
 *
 * Handles detaching the web preview to a chromeless popup window
 * and docking it back. Uses BroadcastChannel for communication.
 */

import { $activeSessionId, $webPreviewDetached, $webPreviewUrl } from '../../stores';
import { hideDetachedPlaceholder, loadPreview } from './webPanel';
import { createLogger } from '../logging';
import { getActiveMode, getActiveUrl, setActiveMode } from './webSessionState';

const log = createLogger('webDetach');
const CHANNEL_NAME = 'midterm-web-preview';

let popup: Window | null = null;
let channel: BroadcastChannel | null = null;
let detachedOwnerSessionId: string | null = null;

/** Initialize the detach system: create BroadcastChannel and wire up detach/dock-back buttons. */
export function initDetach(): void {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = handleMessage;

  document.getElementById('web-preview-detach')?.addEventListener('click', detachPreview);
  document.getElementById('web-preview-dock-back')?.addEventListener('click', dockBack);
}

function handleMessage(e: MessageEvent): void {
  const { type } = e.data;
  if (type === 'dock-back' || type === 'popup-closed') {
    dockBack();
  }
}

/** Open the web preview in a chromeless popup window and hide the dock panel. */
export function detachPreview(): void {
  const activeSessionId = $activeSessionId.get();
  if (!activeSessionId) return;

  if (popup && !popup.closed) {
    popup.focus();
    return;
  }

  const url = getActiveUrl() ?? $webPreviewUrl.get();
  const popupUrl = '/web-preview-popup.html' + (url ? `?url=${encodeURIComponent(url)}` : '');

  popup = window.open(
    popupUrl,
    'midterm-web-preview',
    'popup,width=1280,height=900,menubar=no,toolbar=no,location=no,status=no',
  );

  if (popup) {
    detachedOwnerSessionId = activeSessionId;
    setActiveMode('detached');
    $webPreviewDetached.set(true);
    const dockPanel = document.getElementById('web-preview-dock');
    if (dockPanel) {
      dockPanel.classList.add('hidden');
      dockPanel.style.width = '';
    }
    log.info(() => 'Web preview detached to popup');
  }
}

/** Close the detached popup and restore the web preview back into the dock panel. */
export function dockBack(): void {
  const activeSessionId = $activeSessionId.get();
  if (activeSessionId && detachedOwnerSessionId && activeSessionId !== detachedOwnerSessionId) {
    closeDetachedPopup();
    return;
  }

  if (popup && !popup.closed) {
    popup.close();
  }
  popup = null;
  detachedOwnerSessionId = null;
  setActiveMode('docked');
  $webPreviewDetached.set(false);
  hideDetachedPlaceholder();
  const dockPanel = document.getElementById('web-preview-dock');
  if (dockPanel) {
    dockPanel.classList.remove('hidden');
  }
  loadPreview();
  log.info(() => 'Web preview docked back');
}

/** Close the detached popup and release the BroadcastChannel. */
export function cleanupDetach(): void {
  closeDetachedPopup();
  channel?.close();
  channel = null;
}

/** Close the detached popup when switching sessions without releasing the channel. */
export function cleanupDetachForSessionSwitch(): void {
  closeDetachedPopup();
}

/** Close the detached popup if it was opened by the given session. */
export function closeDetachedIfOwnedBy(sessionId: string | null): void {
  if (!sessionId || detachedOwnerSessionId !== sessionId) return;
  closeDetachedPopup();
}

/** Check whether a detached popup is currently open for the active session. */
export function isDetachedOpenForActiveSession(): boolean {
  const activeSessionId = $activeSessionId.get();
  return (
    !!activeSessionId &&
    detachedOwnerSessionId === activeSessionId &&
    !!popup &&
    !popup.closed &&
    getActiveMode() === 'detached'
  );
}

function closeDetachedPopup(): void {
  if (popup && !popup.closed) {
    popup.close();
  }
  popup = null;
  detachedOwnerSessionId = null;
  $webPreviewDetached.set(false);
}
