/**
 * Web Preview Panel
 *
 * Manages the URL input bar and iframe content within the dock panel.
 */

import { $webPreviewUrl } from '../../stores';
import { setWebPreviewTarget } from './webApi';
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

  goBtn?.addEventListener('click', handleGo);
  urlInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGo();
    }
  });
  refreshBtn?.addEventListener('click', handleRefresh);
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
