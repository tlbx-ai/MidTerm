/**
 * Web Preview Panel
 *
 * Manages the URL input bar and iframe content within the dock panel.
 */

import { $webPreviewUrl, $activeSessionId } from '../../stores';
import { reloadWebPreview, setWebPreviewTarget } from './webApi';
import { pasteToTerminal } from '../terminal';
import { createLogger } from '../logging';
import { getActiveUrl, setActiveMode, setActiveUrl } from './webSessionState';

const log = createLogger('webPanel');
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
  refreshBtn?.addEventListener('click', (e: MouseEvent) => {
    // Shift/Ctrl/Alt-click performs a hard reload (clears preview runtime state).
    const hard = e.shiftKey || e.ctrlKey || e.altKey;
    void handleRefresh(hard ? 'hard' : 'soft');
  });
  screenshotBtn?.addEventListener('click', () => void handleScreenshot());
  document.getElementById('web-preview-dom-html')?.addEventListener('click', handleDomHtml);
  document.getElementById('web-preview-dom-text')?.addEventListener('click', handleDomText);
}

export function restoreLastUrl(): void {
  const saved = getActiveUrl();
  if (saved && urlInput) urlInput.value = saved;
  if (!saved && urlInput) urlInput.value = '';
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
    setActiveMode('docked');
    setActiveUrl(url);
    $webPreviewUrl.set(url);
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

async function handleRefresh(mode: 'soft' | 'hard' = 'soft'): Promise<void> {
  if (mode === 'hard') {
    await clearWebPreviewBrowserStateAsync();
  }

  await reloadWebPreview(mode);
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
 * Paste the iframe's full HTML source into the active terminal session.
 */
function handleDomHtml(): void {
  if (!iframe || iframe.src === 'about:blank') return;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;
  const html = iframe.contentDocument?.documentElement.outerHTML ?? '';
  if (!html) return;
  pasteToTerminal(sessionId, html, false);
  log.info(() => 'DOM outerHTML pasted to terminal');
}

/**
 * Paste the iframe's visible text content into the active terminal session.
 */
function handleDomText(): void {
  if (!iframe || iframe.src === 'about:blank') return;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;
  const text = iframe.contentDocument?.documentElement.innerText ?? '';
  if (!text) return;
  pasteToTerminal(sessionId, text, false);
  log.info(() => 'DOM innerText pasted to terminal');
}

/**
 * Inject html2canvas into the iframe's document on first call; reuse on subsequent calls.
 *
 * We fetch the script in the parent window context (not the iframe's), then inject it via
 * a blob: URL. This bypasses the iframe's URL-rewriting patches: the proxy injects a script
 * into every proxied page that overrides HTMLScriptElement.prototype.src and rewrites
 * root-relative paths like /js/... to /webpreview/js/..., causing the upstream dev server
 * to be asked for html2canvas (which it doesn't have). blob: URLs are explicitly excluded
 * from that rewriter, so they reach the browser's native script loader unchanged.
 */
async function ensureHtml2Canvas(iframeWin: Window): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((iframeWin as any).html2canvas) return;

  // Fetch from parent window — not subject to the iframe's URL-rewriting patches.
  const response = await fetch('/js/html2canvas.min.js');
  const text = await response.text();
  const blob = new Blob([text], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const script = iframeWin.document.createElement('script');
    script.src = blobUrl; // blob: URLs bypass the iframe's src-setter rewrite patch
    script.onload = () => {
      URL.revokeObjectURL(blobUrl);
      resolve();
    };
    script.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to load html2canvas'));
    };
    iframeWin.document.head.appendChild(script);
  });
}

/**
 * Capture a screenshot of the web preview iframe using html2canvas.
 * Runs entirely inside the iframe's own window context so getComputedStyle
 * and other DOM APIs resolve correctly against the proxied document.
 * No permission dialog, no screen-sharing indicator.
 */
async function captureIframeScreenshot(): Promise<Blob | null> {
  if (!iframe || iframe.src === 'about:blank') return null;
  const iframeWin = iframe.contentWindow;
  const iframeDoc = iframe.contentDocument;
  if (!iframeWin || !iframeDoc) return null;

  await ensureHtml2Canvas(iframeWin);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas: HTMLCanvasElement = await (iframeWin as any).html2canvas(
    iframeDoc.documentElement,
    {
      useCORS: false, // not needed — all resources are same-origin via the proxy
      allowTaint: false,
      scale: window.devicePixelRatio || 1,
      width: iframe.clientWidth,
      height: iframe.clientHeight,
      scrollX: -iframeDoc.documentElement.scrollLeft,
      scrollY: -iframeDoc.documentElement.scrollTop,
      windowWidth: iframe.clientWidth,
      windowHeight: iframe.clientHeight,
      logging: false,
      imageTimeout: 15000,
    },
  );

  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Capture a screenshot of the web preview iframe and paste the file path into the terminal.
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

async function clearWebPreviewBrowserStateAsync(): Promise<void> {
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.filter((r) => r.scope.includes('/webpreview')).map((r) => r.unregister()),
      );
    } catch {
      // ignore
    }
  }

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.toLowerCase().includes('webpreview')).map((k) => caches.delete(k)),
      );
    } catch {
      // ignore
    }
  }
}
