/**
 * Web Preview Panel
 *
 * Manages the URL input bar and iframe content within the dock panel.
 */

import { $webPreviewUrl, $activeSessionId } from '../../stores';
import { reloadWebPreview, setWebPreviewTarget } from './webApi';
import { pasteToTerminal } from '../terminal';
import { sendInput } from '../comms/muxChannel';
import { getForegroundInfo } from '../process';
import { createLogger } from '../logging';
import { getActiveUrl, setActiveMode, setActiveUrl } from './webSessionState';

interface UploadResponse {
  path?: string;
}

interface Html2CanvasWindow extends Window {
  html2canvas?: (el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement>;
}

const log = createLogger('webPanel');
let urlInput: HTMLInputElement | null = null;
let iframe: HTMLIFrameElement | null = null;
let loadedUrl: string | null = null;

/** Get the URL currently loaded in the iframe (null if unloaded). */
export function getLoadedUrl(): string | null {
  return loadedUrl;
}

/** Initialize the web preview panel: wire up URL input, buttons, and keyboard shortcuts. */
export function initWebPanel(): void {
  urlInput = document.getElementById('web-preview-url-input') as HTMLInputElement;
  iframe = document.getElementById('web-preview-iframe') as HTMLIFrameElement;

  const goBtn = document.getElementById('web-preview-go');
  const refreshBtn = document.getElementById('web-preview-refresh');
  const screenshotBtn = document.getElementById('web-preview-screenshot');

  goBtn?.addEventListener('click', () => {
    void handleGo();
  });
  urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleGo();
    }
  });
  refreshBtn?.addEventListener('click', (e: MouseEvent) => {
    // Shift/Ctrl/Alt-click performs a hard reload (clears preview runtime state).
    const hard = e.shiftKey || e.ctrlKey || e.altKey;
    void handleRefresh(hard ? 'hard' : 'soft');
  });
  screenshotBtn?.addEventListener('click', (e: MouseEvent) => void handleScreenshot(e.ctrlKey));
  document.getElementById('web-preview-agent-hint')?.addEventListener('click', handleAgentHint);

  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    const d = e.data as Record<string, unknown> | null;
    if (d && d.type === 'mt-navigation' && typeof d.url === 'string') {
      updateUrlBarFromIframe(d.url);
    }
  });
}

/** Restore the last-used URL for the active session into the URL input bar. */
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

/** Reload the web preview iframe with a cache-busting query parameter. */
export function loadPreview(): void {
  if (!iframe) return;
  loadedUrl = $webPreviewUrl.get();
  let targetPath = '';
  try {
    const url = new URL(loadedUrl ?? '');
    targetPath = url.pathname.replace(/\/$/, '');
  } catch {
    /* ignore invalid URLs */
  }
  iframe.src = `/webpreview${targetPath}/?${Date.now()}`;
}

async function handleRefresh(mode: 'soft' | 'hard' = 'soft'): Promise<void> {
  if (mode === 'hard') {
    await clearWebPreviewBrowserStateAsync();
  }

  await reloadWebPreview(mode);
  loadPreview();
}

/**
 * Update the URL bar to reflect in-iframe navigation (redirects, pushState, etc.).
 * Strips the /webpreview prefix and reconstructs the upstream URL.
 */
function updateUrlBarFromIframe(iframeUrl: string): void {
  if (!urlInput) return;
  try {
    const parsed = new URL(iframeUrl);
    let path = parsed.pathname;
    if (path.startsWith('/webpreview/')) {
      path = path.slice('/webpreview'.length);
    } else if (path === '/webpreview') {
      path = '/';
    }
    const target = $webPreviewUrl.get();
    if (!target) return;
    const targetUrl = new URL(target);
    const displayUrl = targetUrl.origin + path + parsed.search + parsed.hash;
    urlInput.value = displayUrl;
  } catch {
    // ignore malformed URLs
  }
}

/** Show the web preview iframe and hide the detached placeholder message. */
export function showIframe(): void {
  if (iframe) iframe.classList.remove('hidden');
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.add('hidden');
}

/** Hide the web preview iframe. */
export function hideIframe(): void {
  if (iframe) iframe.classList.add('hidden');
}

/** Unload the iframe by navigating to about:blank and hiding it. */
export function unloadIframe(): void {
  if (iframe) {
    iframe.src = 'about:blank';
    iframe.classList.add('hidden');
  }
  loadedUrl = null;
}

/** Show the "detached" placeholder message and hide the iframe. */
export function showDetachedPlaceholder(): void {
  hideIframe();
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.remove('hidden');
}

/** Hide the "detached" placeholder message and show the iframe. */
export function hideDetachedPlaceholder(): void {
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) placeholder.classList.add('hidden');
  showIframe();
}

/**
 * Inject a chat message into the active terminal telling the agent to read
 * the browser control guidance file. Points to CLAUDE.md for Claude Code,
 * AGENTS.md for all other processes.
 */
function handleAgentHint(): void {
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  const fg = getForegroundInfo(sessionId);
  const name = (fg.name ?? '').toLowerCase();
  const guidanceFile = name === 'claude' ? '.midterm/CLAUDE.md' : '.midterm/AGENTS.md';
  const message = `Read the file ${guidanceFile} for instructions on how to interact with this browser preview.\n`;

  sendInput(sessionId, message);
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
async function ensureHtml2Canvas(iframeWin: Html2CanvasWindow): Promise<void> {
  if (iframeWin.html2canvas) return;

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

  const typedWin = iframeWin as Html2CanvasWindow;
  await ensureHtml2Canvas(typedWin);

  if (!typedWin.html2canvas) return null;
  const canvas: HTMLCanvasElement = await typedWin.html2canvas(iframeDoc.documentElement, {
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
  });

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

/**
 * Capture a screenshot of the web preview iframe.
 * Ctrl+click downloads the PNG directly to the browser; plain click uploads and pastes the
 * file path into the active terminal session.
 */
async function handleScreenshot(download = false): Promise<void> {
  if (!iframe || iframe.src === 'about:blank') return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot_${ts}.png`;

  const blob = await captureIframeScreenshot();
  if (!blob) return;

  if (download) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    log.info(() => 'Screenshot downloaded');
    return;
  }

  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    log.warn(() => 'No active session for screenshot');
    return;
  }

  const file = new File([blob], filename, { type: 'image/png' });
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
    const result = (await resp.json()) as UploadResponse;
    if (result.path) {
      pasteToTerminal(sessionId, result.path, true);
      log.info(() => 'Screenshot pasted to terminal');
    }
  } catch (err) {
    log.warn(() => `Screenshot upload error: ${String(err)}`);
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
