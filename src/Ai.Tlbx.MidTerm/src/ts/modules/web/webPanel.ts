/**
 * Web Preview Panel
 *
 * Manages the URL input bar and iframe content within the dock panel.
 */

import { $webPreviewUrl, $activeSessionId } from '../../stores';
import { setWebPreviewTarget } from './webApi';
import { pasteToTerminal } from '../terminal';
import { createLogger } from '../logging';

const log = createLogger('webPanel');
const URL_STORAGE_KEY = 'mt-web-preview-url';

let urlInput: HTMLInputElement | null = null;
let iframe: HTMLIFrameElement | null = null;

export function initWebPanel(): void {
  urlInput = document.getElementById('web-preview-url-input') as HTMLInputElement;
  iframe = document.getElementById('web-preview-iframe') as HTMLIFrameElement;

  const goBtn = document.getElementById('web-preview-go');
  const refreshBtn = document.getElementById('web-preview-refresh');
  const screenshotBtn = document.getElementById('web-preview-screenshot');

  goBtn?.addEventListener('click', handleGo);
  urlInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGo();
    }
  });
  refreshBtn?.addEventListener('click', handleRefresh);
  screenshotBtn?.addEventListener('click', handleScreenshot);
}

export function restoreLastUrl(): void {
  const saved = localStorage.getItem(URL_STORAGE_KEY);
  if (saved && urlInput) {
    urlInput.value = saved;
  }
}

function normalizeUrl(raw: string): string {
  if (!raw.includes('://')) {
    const isLocal =
      raw.startsWith('localhost') || raw.startsWith('127.0.0.1') || raw.startsWith('[::1]');
    return (isLocal ? 'http://' : 'https://') + raw;
  }
  return raw;
}

async function handleGo(): Promise<void> {
  if (!urlInput) return;
  const url = normalizeUrl(urlInput.value.trim());
  if (!url) return;

  // Show the normalized URL back to the user
  urlInput.value = url;

  log.info(() => `Setting web preview target: ${url}`);
  const result = await setWebPreviewTarget(url);
  if (result?.active) {
    $webPreviewUrl.set(url);
    localStorage.setItem(URL_STORAGE_KEY, url);
    loadPreview();
  } else {
    log.warn(() => 'Failed to set web preview target');
  }
}

export function loadPreview(): void {
  if (!iframe) return;
  // Force reload by setting src with a cache-busting fragment
  iframe.src = '/webpreview/' + '?' + Date.now();
}

function handleRefresh(): void {
  loadPreview();
}

export function showIframe(): void {
  if (iframe) iframe.classList.remove('hidden');
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.add('hidden');
}

export function hideIframe(): void {
  if (iframe) iframe.classList.add('hidden');
}

export function unloadIframe(): void {
  if (iframe) {
    iframe.src = 'about:blank';
    iframe.classList.add('hidden');
  }
}

export function showDetachedPlaceholder(): void {
  hideIframe();
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.remove('hidden');
}

export function hideDetachedPlaceholder(): void {
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.add('hidden');
  showIframe();
}

/**
 * Capture a screenshot of the web preview iframe using the Screen Capture API,
 * upload it to the active session, and paste the file path into the terminal.
 */
async function handleScreenshot(): Promise<void> {
  if (!iframe || iframe.src === 'about:blank') return;

  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    log.warn(() => 'No active session for screenshot');
    return;
  }

  const blob = await captureIframeScreenshot();
  if (!blob) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([blob], `screenshot_${ts}.png`, { type: 'image/png' });
  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch(`/api/sessions/${sessionId}/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!resp.ok) {
      log.warn(() => `Screenshot upload failed: ${resp.status}`);
      return;
    }
    const result = await resp.json();
    if (result.path) {
      pasteToTerminal(sessionId, result.path, true);
      log.info(() => 'Screenshot pasted to terminal');
    }
  } catch (err) {
    log.warn(() => `Screenshot upload error: ${err}`);
  }
}

/**
 * Use getDisplayMedia to capture the current tab, then crop to the iframe area.
 */
async function captureIframeScreenshot(): Promise<Blob | null> {
  if (!iframe) return null;

  const rect = iframe.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      preferCurrentTab: true,
    } as any);
  } catch {
    // User cancelled the permission dialog
    return null;
  }

  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    // Wait for at least one frame to be rendered
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // Calculate scale between captured resolution and CSS pixels
    const track = stream.getVideoTracks()[0]!;
    const settings = track.getSettings();
    const captureW = settings.width || video.videoWidth;
    const captureH = settings.height || video.videoHeight;
    const scaleX = captureW / window.innerWidth;
    const scaleY = captureH / window.innerHeight;

    // Crop to iframe area
    const sx = Math.round(rect.left * scaleX);
    const sy = Math.round(rect.top * scaleY);
    const sw = Math.round(rect.width * scaleX);
    const sh = Math.round(rect.height * scaleY);

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
