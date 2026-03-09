/**
 * Web Preview Panel
 *
 * Manages the URL input bar and iframe content within the dock panel.
 */

import { $webPreviewUrl, $activeSessionId } from '../../stores';
import {
  captureBrowserScreenshotRaw,
  clearWebPreviewCookies,
  createBrowserPreviewClient,
  reloadWebPreview,
  setWebPreviewTarget,
  type BrowserPreviewClientResponse,
} from './webApi';
import { pasteToTerminal } from '../terminal';
import { sendInput } from '../comms/muxChannel';
import { getForegroundInfo } from '../process';
import { createLogger } from '../logging';
import { isDevMode } from '../sidebar/voiceSection';
import {
  getActiveDockedClient,
  getActiveUrl,
  getSessionDockedClient,
  setActiveMode,
  setActiveUrl,
  setSessionDockedClient,
} from './webSessionState';

interface UploadResponse {
  path?: string;
}

interface PreviewBridgeMessage {
  previewId?: string;
  previewToken?: string;
  sessionId?: string;
}

interface PreviewNavigationMessage extends PreviewBridgeMessage {
  type: 'mt-navigation';
  url: string;
  targetOrigin?: string;
  upstreamUrl?: string;
}

interface PreviewCookieRequestMessage extends PreviewBridgeMessage {
  type: 'mt-cookie-request';
  requestId: string;
  action: 'get' | 'set';
  raw?: string;
  upstreamUrl?: string;
}

interface PreviewCookieResponseMessage extends PreviewBridgeMessage {
  type: 'mt-cookie-response';
  requestId: string;
  header?: string;
  error?: string;
}

const COOKIE_BRIDGE_PATH = '/webpreview/_cookies';
const SANDBOX_FLAGS = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

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

  applyIframeSandbox();

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
    const hard = e.shiftKey || e.ctrlKey || e.altKey;
    void handleRefresh(hard ? 'hard' : 'soft');
  });
  screenshotBtn?.addEventListener('click', (e: MouseEvent) => void handleScreenshot(e.ctrlKey));
  document.getElementById('web-preview-clear-cookies')?.addEventListener('click', () => {
    void handleClearCookies();
  });
  document.getElementById('web-preview-agent-hint')?.addEventListener('click', handleAgentHint);

  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string } | null;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'mt-navigation') {
      const nav = e.data as PreviewNavigationMessage;
      if (!isActivePreviewMessage(nav)) return;
      updateUrlBarFromIframe(
        nav.url,
        nav.upstreamUrl,
        typeof nav.targetOrigin === 'string' ? nav.targetOrigin : undefined,
      );
      return;
    }

    if (data.type === 'mt-cookie-request') {
      const request = e.data as PreviewCookieRequestMessage;
      if (!isActivePreviewMessage(request)) return;
      void handleCookieBridgeRequest(e, request);
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

function applyIframeSandbox(): void {
  if (!iframe) return;
  if (isDevMode()) {
    iframe.setAttribute('sandbox', SANDBOX_FLAGS);
    return;
  }
  iframe.removeAttribute('sandbox');
}

async function handleGo(): Promise<void> {
  if (!urlInput) return;
  const url = normalizeUrl(urlInput.value.trim());
  if (!url) return;

  urlInput.value = url;

  log.info(() => `Setting web preview target: ${url}`);
  const result = await setWebPreviewTarget(url);
  if (result?.active) {
    setActiveMode('docked');
    setCurrentPreviewUrl(url);
    await loadPreview();
  } else {
    log.warn(() => 'Failed to set web preview target');
  }
}

function buildProxyUrl(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  const path = parsed.pathname || '/';
  const proxyUrl = new URL(
    path === '/' ? '/webpreview/' : `/webpreview${path}`,
    window.location.origin,
  );
  proxyUrl.search = parsed.search;
  proxyUrl.hash = parsed.hash;
  return `${proxyUrl.pathname}${proxyUrl.search}${proxyUrl.hash}`;
}

function decodeIframeNavigationUrl(iframeUrl: string, targetOrigin?: string): string | null {
  const parsed = new URL(iframeUrl);

  if (parsed.pathname === '/webpreview/_ext') {
    const externalUrl = parsed.searchParams.get('u');
    return externalUrl ? externalUrl : null;
  }

  let path = parsed.pathname;
  if (path.startsWith('/webpreview/')) {
    path = path.slice('/webpreview'.length);
  } else if (path === '/webpreview') {
    path = '/';
  } else {
    return parsed.toString();
  }

  const baseOrigin =
    targetOrigin ||
    (() => {
      const target = getActiveUrl() ?? $webPreviewUrl.get();
      if (!target) return null;
      return new URL(target).origin;
    })();

  if (!baseOrigin) return null;
  return `${baseOrigin}${path}${parsed.search}${parsed.hash}`;
}

function setCurrentPreviewUrl(url: string, updateInput = true): void {
  loadedUrl = url;
  setActiveUrl(url);
  $webPreviewUrl.set(url);
  if (updateInput && urlInput) {
    urlInput.value = url;
  }
}

async function ensureDockedPreviewClient(
  sessionId: string,
): Promise<BrowserPreviewClientResponse | null> {
  const existing = getSessionDockedClient(sessionId);
  if (existing?.previewId && existing.previewToken) {
    return existing;
  }

  const created = await createBrowserPreviewClient(sessionId);
  if (!created) {
    return null;
  }

  setSessionDockedClient(sessionId, created);
  return created;
}

function isActivePreviewMessage(message: PreviewBridgeMessage): boolean {
  const activeClient = getActiveDockedClient();
  return (
    !!activeClient &&
    message.previewId === activeClient.previewId &&
    message.previewToken === activeClient.previewToken
  );
}

function postCookieBridgeResponse(
  target: WindowProxy | null,
  message: PreviewCookieResponseMessage,
): void {
  if (!target) return;
  target.postMessage(message, '*');
}

async function handleCookieBridgeRequest(
  event: MessageEvent<unknown>,
  request: PreviewCookieRequestMessage,
): Promise<void> {
  const target = event.source as WindowProxy | null;
  const upstreamUrl =
    typeof request.upstreamUrl === 'string' ? request.upstreamUrl : getActiveUrl();
  const url = new URL(COOKIE_BRIDGE_PATH, window.location.origin);
  if (upstreamUrl) {
    url.searchParams.set('u', upstreamUrl);
  }

  const responseMessage: PreviewCookieResponseMessage = {
    type: 'mt-cookie-response',
    requestId: request.requestId,
  };
  if (typeof request.previewId === 'string') {
    responseMessage.previewId = request.previewId;
  }
  if (typeof request.previewToken === 'string') {
    responseMessage.previewToken = request.previewToken;
  }
  if (typeof request.sessionId === 'string') {
    responseMessage.sessionId = request.sessionId;
  }

  try {
    const response =
      request.action === 'set'
        ? await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: request.raw ?? '' }),
          })
        : await fetch(url.toString(), { method: 'GET' });

    if (!response.ok) {
      responseMessage.error = `Cookie bridge failed: ${response.status}`;
      postCookieBridgeResponse(target, responseMessage);
      return;
    }

    const data = (await response.json()) as { header?: string };
    responseMessage.header = typeof data.header === 'string' ? data.header : '';
  } catch (error) {
    responseMessage.error = String(error);
  }

  postCookieBridgeResponse(target, responseMessage);
}

/** Load the current web preview URL into the iframe. */
export async function loadPreview(): Promise<void> {
  if (!iframe) return;
  applyIframeSandbox();
  const sessionId = $activeSessionId.get();
  const currentUrl = getActiveUrl() ?? $webPreviewUrl.get();
  loadedUrl = currentUrl;

  if (!currentUrl || !sessionId) {
    iframe.name = '';
    iframe.src = 'about:blank';
    return;
  }

  const previewClient = await ensureDockedPreviewClient(sessionId);
  if ($activeSessionId.get() !== sessionId) {
    return;
  }

  if (!previewClient) {
    iframe.name = '';
    iframe.src = 'about:blank';
    log.warn(() => `Failed to create browser preview client for session ${sessionId}`);
    return;
  }

  try {
    iframe.name = JSON.stringify(previewClient);
    iframe.src = buildProxyUrl(currentUrl);
  } catch {
    iframe.name = '';
    iframe.src = 'about:blank';
  }
}

async function handleRefresh(mode: 'soft' | 'hard' = 'soft'): Promise<void> {
  if (mode === 'hard') {
    await clearWebPreviewBrowserStateAsync();
  }

  const currentUrl = getActiveUrl() ?? $webPreviewUrl.get();
  if (currentUrl) {
    const result = await setWebPreviewTarget(currentUrl);
    if (!result?.active) {
      log.warn(() => 'Failed to refresh web preview target');
      return;
    }
    setCurrentPreviewUrl(currentUrl, false);
  }

  await reloadWebPreview(mode);
  await loadPreview();
}

/**
 * Update the URL bar to reflect in-iframe navigation (redirects, pushState, etc.).
 * Uses the upstream URL supplied by the injected proxy runtime when available.
 */
function updateUrlBarFromIframe(
  iframeUrl: string,
  upstreamUrl?: string,
  targetOrigin?: string,
): void {
  try {
    const displayUrl = upstreamUrl || decodeIframeNavigationUrl(iframeUrl, targetOrigin);
    if (!displayUrl) return;
    setCurrentPreviewUrl(displayUrl);
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
    iframe.name = '';
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

function decodeScreenshotDataUrl(dataUrl: string): Blob | null {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return null;

  const meta = dataUrl.slice(0, commaIndex);
  const mime = /^data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
  try {
    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Capture a screenshot of the web preview iframe via the injected browser bridge.
 * Ctrl+click downloads the PNG directly to the browser; plain click uploads and pastes the
 * file path into the active terminal session.
 */
async function handleScreenshot(download = false): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId || !iframe || iframe.src === 'about:blank') return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot_${ts}.png`;

  const dataUrl = await captureBrowserScreenshotRaw(sessionId);
  if (!dataUrl) {
    log.warn(() => 'Browser screenshot capture failed');
    return;
  }

  const blob = decodeScreenshotDataUrl(dataUrl);
  if (!blob) {
    log.warn(() => 'Failed to decode browser screenshot');
    return;
  }

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
      void pasteToTerminal(sessionId, result.path, true);
      log.info(() => 'Screenshot pasted to terminal');
    }
  } catch (err) {
    log.warn(() => `Screenshot upload error: ${String(err)}`);
  }
}

async function handleClearCookies(): Promise<void> {
  const ok = await clearWebPreviewCookies();
  if (ok) {
    log.info(() => 'Cookies cleared');
    await loadPreview();
  } else {
    log.warn(() => 'Failed to clear cookies');
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
