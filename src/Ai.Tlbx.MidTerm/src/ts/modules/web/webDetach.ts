/**
 * Web Preview Detach
 *
 * Handles detaching the web preview to a chromeless popup window
 * and docking it back. Uses BroadcastChannel for communication.
 */

import { $webPreviewDetached, $webPreviewUrl } from '../../stores';
import { showDetachedPlaceholder, hideDetachedPlaceholder, loadPreview } from './webPanel';
import { createLogger } from '../logging';

const log = createLogger('webDetach');
const CHANNEL_NAME = 'midterm-web-preview';

let popup: Window | null = null;
let channel: BroadcastChannel | null = null;

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

export function detachPreview(): void {
  if (popup && !popup.closed) {
    popup.focus();
    return;
  }

  const url = $webPreviewUrl.get();
  const popupUrl = '/web-preview-popup.html' + (url ? `?url=${encodeURIComponent(url)}` : '');

  popup = window.open(
    popupUrl,
    'midterm-web-preview',
    'popup,width=1280,height=900,menubar=no,toolbar=no,location=no,status=no',
  );

  if (popup) {
    $webPreviewDetached.set(true);
    showDetachedPlaceholder();
    log.info(() => 'Web preview detached to popup');
  }
}

export function dockBack(): void {
  if (popup && !popup.closed) {
    popup.close();
  }
  popup = null;
  $webPreviewDetached.set(false);
  hideDetachedPlaceholder();
  loadPreview();
  log.info(() => 'Web preview docked back');
}

export function cleanupDetach(): void {
  if (popup && !popup.closed) {
    popup.close();
  }
  popup = null;
  channel?.close();
  channel = null;
}
