/**
 * Web Preview Panel
 *
 * Manages the URL bar, named preview tabs, and iframe content in the dock panel.
 */

import { $webPreviewUrl, $activeSessionId } from '../../stores';
import {
  clearWebPreviewState,
  getBrowserPreviewStatus,
  runBrowserCommand,
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
import { getAgentGuidanceFile } from '../midtermGuidance';
import { isDevMode } from '../sidebar/voiceSection';
import {
  buildPreviewLoadToken,
  PREVIEW_LOAD_TOKEN_ATTRIBUTE,
  PREVIEW_LOAD_TOKEN_DATASET_KEY,
  shouldReloadPreviewFrame,
} from './previewLoadToken';
import {
  buildProxyUrl,
  sanitizePreviewDisplayUrl,
  stripInternalPreviewQueryParams,
} from './previewProxyUrl';
import {
  getActiveDockedClient,
  getActivePreview,
  getActivePreviewName,
  getActiveUrl,
  getSessionDockedClient,
  listSessionPreviews,
  setActiveMode,
  setActiveUrl,
  setSessionDockedClient,
  upsertSessionPreview,
} from './webSessionState';
import { shouldSandboxPreviewFrame } from './previewSandbox';
import { buildBrowserPreviewStatusIndicatorState } from './webPreviewStatus';

interface UploadResponse {
  path?: string;
}

interface PreviewBridgeMessage {
  previewId?: string;
  previewToken?: string;
  sessionId?: string;
  previewName?: string;
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

const SANDBOX_BASE_FLAGS = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-downloads',
];

const log = createLogger('webPanel');
const PREVIEW_CONTEXT_COOKIE_NAME = 'mt-preview-ctx';
let urlInput: HTMLInputElement | null = null;
let iframeHost: HTMLElement | null = null;
let previewTabs: HTMLElement | null = null;
let statusIndicator: HTMLElement | null = null;
let loadedUrl: string | null = null;
let previewTabSelectHandler: ((previewName: string) => void) | null = null;
let activeFrameKey: string | null = null;
const previewFrames = new Map<string, HTMLIFrameElement>();
const STATUS_REFRESH_INTERVAL_MS = 4000;
let statusRefreshTimer: number | null = null;

const FRAME_ALLOW_ATTR = `
  camera *;
  microphone *;
  geolocation *;
  fullscreen *;
  autoplay *;
  clipboard-read *;
  clipboard-write *;
  display-capture *;
`;

/** Get the URL currently loaded in the iframe. */
export function getLoadedUrl(): string | null {
  return loadedUrl;
}

/** Register a callback for preview tab selection. */
export function setPreviewTabSelectHandler(handler: (previewName: string) => void): void {
  previewTabSelectHandler = handler;
}

/** Render the active session's named preview tabs. */
export function renderPreviewTabs(): void {
  if (!previewTabs) {
    return;
  }

  const sessionId = $activeSessionId.get();
  const selectedPreviewName = getActivePreviewName();
  previewTabs.replaceChildren();

  if (!sessionId) {
    return;
  }

  for (const preview of listSessionPreviews(sessionId)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'web-preview-tab';
    if (preview.previewName === selectedPreviewName) {
      button.classList.add('active');
    }
    if (preview.mode === 'detached') {
      button.classList.add('detached');
    }
    if (!preview.url) {
      button.classList.add('empty');
    }
    button.textContent = preview.previewName;
    button.dataset.previewName = preview.previewName;
    button.addEventListener('click', () => {
      previewTabSelectHandler?.(preview.previewName);
    });
    previewTabs.appendChild(button);
  }
}

/** Initialize the web preview panel. */
export function initWebPanel(): void {
  urlInput = document.getElementById('web-preview-url-input') as HTMLInputElement | null;
  iframeHost = document.getElementById('web-preview-iframe-host');
  previewTabs = document.getElementById('web-preview-tabs');
  statusIndicator = document.getElementById('web-preview-status-indicator');

  const goBtn = document.getElementById('web-preview-go');
  const refreshBtn = document.getElementById('web-preview-refresh');
  const screenshotBtn = document.getElementById('web-preview-screenshot');

  applyIframeSandbox();
  renderPreviewTabs();

  goBtn?.addEventListener('click', () => {
    void handleGo();
  });
  urlInput?.addEventListener('keydown', (e: KeyboardEvent) => {
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
  document.getElementById('web-preview-clear-state')?.addEventListener('click', () => {
    void handleClearState();
  });
  document.getElementById('web-preview-agent-hint')?.addEventListener('click', handleAgentHint);
  document.addEventListener('visibilitychange', () => {
    void refreshBrowserPreviewStatus();
  });
  window.addEventListener('focus', () => {
    void refreshBrowserPreviewStatus();
  });
  window.addEventListener('blur', () => {
    void refreshBrowserPreviewStatus();
  });
  if (statusRefreshTimer === null) {
    statusRefreshTimer = window.setInterval(() => {
      void refreshBrowserPreviewStatus();
    }, STATUS_REFRESH_INTERVAL_MS);
  }

  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (!findPreviewIframeByWindow(e.source)) {
      return;
    }

    const data = e.data as { type?: string } | null;
    if (!data || typeof data.type !== 'string') {
      return;
    }

    if (data.type === 'mt-navigation') {
      const nav = e.data as PreviewNavigationMessage;
      if (!isActivePreviewMessage(nav)) {
        return;
      }
      updateUrlBarFromIframe(
        nav.url,
        nav.upstreamUrl,
        typeof nav.targetOrigin === 'string' ? nav.targetOrigin : undefined,
      );
      return;
    }

    if (data.type === 'mt-cookie-request') {
      const request = e.data as PreviewCookieRequestMessage;
      if (!isActivePreviewMessage(request)) {
        return;
      }
      void handleCookieBridgeRequest(e, request);
    }
  });
}

/** Restore the active preview URL into the URL bar. */
export function restoreLastUrl(): void {
  const saved = getActiveUrl();
  if (!urlInput) {
    return;
  }
  urlInput.value = saved ?? '';
}

function normalizeUrl(raw: string): string {
  if (!raw.includes('://')) {
    const isLocal =
      raw.startsWith('localhost') || raw.startsWith('127.0.0.1') || raw.startsWith('[::1]');
    return `${isLocal ? 'http://' : 'https://'}${raw}`;
  }
  return raw;
}

function getProxyPrefix(routeKey: string): string {
  return `/webpreview/${encodeURIComponent(routeKey)}`;
}

function getCookieBridgePath(routeKey: string): string {
  return `${getProxyPrefix(routeKey)}/_cookies`;
}

function setPreviewContextCookie(previewClient: BrowserPreviewClientResponse): void {
  const routeKey = previewClient.routeKey.trim();
  if (!routeKey || !previewClient.previewId || !previewClient.previewToken) {
    return;
  }

  const payload = encodeURIComponent(
    JSON.stringify({
      sessionId: previewClient.sessionId ?? '',
      previewName: previewClient.previewName,
      routeKey: previewClient.routeKey,
      previewId: previewClient.previewId,
      previewToken: previewClient.previewToken,
    }),
  );

  document.cookie =
    `${PREVIEW_CONTEXT_COOKIE_NAME}=${payload}; ` +
    `path=${getProxyPrefix(routeKey)}/; secure; samesite=lax`;
}

function shouldAllowSameOriginSandbox(frameOrigin?: string): boolean {
  if (!frameOrigin) {
    return false;
  }

  try {
    return new URL(frameOrigin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function getSandboxFlags(frameOrigin?: string): string {
  const flags = [...SANDBOX_BASE_FLAGS];
  if (shouldAllowSameOriginSandbox(frameOrigin)) {
    flags.push('allow-same-origin');
  }
  return flags.join(' ');
}

function applyIframeSandbox(
  frameOrigin?: string,
  targetFrame?: HTMLIFrameElement | null,
  targetUrl?: string | null,
): void {
  const frame = targetFrame ?? getActiveIframe();
  if (!frame) {
    return;
  }

  if (shouldSandboxPreviewFrame(targetUrl ?? getActiveUrl(), isDevMode())) {
    frame.setAttribute('sandbox', getSandboxFlags(frameOrigin));
    return;
  }
  frame.removeAttribute('sandbox');
}

async function handleGo(): Promise<void> {
  if (!urlInput) {
    return;
  }

  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  if (!sessionId) {
    return;
  }

  const url = normalizeUrl(urlInput.value.trim());
  if (!url) {
    return;
  }

  urlInput.value = url;

  log.info(() => `Setting web preview target: ${sessionId}/${previewName} -> ${url}`);
  const result = await setWebPreviewTarget(sessionId, previewName, url);
  if (!result?.active) {
    log.warn(() => 'Failed to set web preview target');
    return;
  }

  setActiveMode('docked');
  setCurrentPreviewUrl(url);
  await loadPreview();
}

function decodeIframeNavigationUrl(
  iframeUrl: string,
  routeKey: string,
  targetOrigin?: string,
): string | null {
  const parsed = new URL(iframeUrl, window.location.origin);
  const prefix = getProxyPrefix(routeKey);

  if (parsed.pathname === `${prefix}/_ext`) {
    return parsed.searchParams.get('u');
  }

  let path = parsed.pathname;
  if (path.startsWith(`${prefix}/`)) {
    path = path.slice(prefix.length);
  } else if (path === prefix) {
    path = '/';
  } else {
    return parsed.toString();
  }

  stripInternalPreviewQueryParams(parsed);

  const baseOrigin =
    targetOrigin ||
    (() => {
      const target = getActiveUrl() ?? $webPreviewUrl.get();
      if (!target) {
        return null;
      }
      return new URL(target).origin;
    })();

  if (!baseOrigin) {
    return null;
  }

  return `${baseOrigin}${path}${parsed.search}${parsed.hash}`;
}

function setCurrentPreviewUrl(url: string | null, updateInput = true): void {
  const sanitizedUrl = url ? sanitizePreviewDisplayUrl(url) : null;
  const nextInputValue = sanitizedUrl ?? '';
  if (
    loadedUrl === sanitizedUrl &&
    $webPreviewUrl.get() === sanitizedUrl &&
    (!updateInput || !urlInput || urlInput.value === nextInputValue)
  ) {
    return;
  }

  loadedUrl = sanitizedUrl;
  setActiveUrl(sanitizedUrl);
  $webPreviewUrl.set(sanitizedUrl);
  if (updateInput && urlInput) {
    urlInput.value = nextInputValue;
  }
}

async function ensureDockedPreviewClient(
  sessionId: string,
  previewName: string,
): Promise<BrowserPreviewClientResponse | null> {
  const existing = getSessionDockedClient(sessionId, previewName);
  if (existing?.previewId && existing.previewToken && existing.routeKey) {
    return existing;
  }

  const created = await createBrowserPreviewClient(sessionId, previewName);
  if (!created) {
    return null;
  }

  setSessionDockedClient(sessionId, previewName, created);
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

function getPreviewFrameKey(sessionId: string, previewName: string): string {
  return `${sessionId}::${previewName}`;
}

function getActivePreviewFrameKey(): string | null {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    return null;
  }

  return getPreviewFrameKey(sessionId, getActivePreviewName());
}

function getActiveIframe(): HTMLIFrameElement | null {
  const key = activeFrameKey ?? getActivePreviewFrameKey();
  if (!key) {
    return null;
  }

  return previewFrames.get(key) ?? null;
}

function createPreviewIframe(frameKey: string): HTMLIFrameElement | null {
  if (!iframeHost) {
    return null;
  }

  const frame = document.createElement('iframe');
  frame.className = 'web-preview-iframe hidden';
  frame.src = 'about:blank';
  frame.setAttribute('allow', FRAME_ALLOW_ATTR.trim());
  frame.dataset.previewFrameKey = frameKey;
  iframeHost.appendChild(frame);
  previewFrames.set(frameKey, frame);
  return frame;
}

function replacePreviewIframe(frameKey: string): HTMLIFrameElement | null {
  const existing = previewFrames.get(frameKey);
  if (existing) {
    existing.name = '';
    existing.src = 'about:blank';
    existing.remove();
    previewFrames.delete(frameKey);
  }

  if (activeFrameKey === frameKey) {
    activeFrameKey = null;
  }

  return createPreviewIframe(frameKey);
}

function ensurePreviewIframe(sessionId: string, previewName: string): HTMLIFrameElement | null {
  const frameKey = getPreviewFrameKey(sessionId, previewName);
  return previewFrames.get(frameKey) ?? createPreviewIframe(frameKey);
}

function shouldRemountPreviewFrame(
  frame: HTMLIFrameElement,
  previewClient: BrowserPreviewClientResponse,
  targetUrl: string,
  targetRevision: number,
): boolean {
  const nextLoadToken = buildPreviewLoadToken(targetUrl, targetRevision);
  if (frame.dataset[PREVIEW_LOAD_TOKEN_DATASET_KEY] !== nextLoadToken) {
    return true;
  }

  const currentFrameIdentity = frame.name || '';
  const nextFrameIdentity = JSON.stringify(previewClient);
  return currentFrameIdentity !== nextFrameIdentity;
}

function findPreviewIframeByWindow(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) {
    return null;
  }

  for (const frame of previewFrames.values()) {
    if (frame.contentWindow === source) {
      return frame;
    }
  }

  return null;
}

function setVisiblePreviewFrame(frameKey: string | null): void {
  activeFrameKey = frameKey;
  for (const [key, frame] of previewFrames) {
    const isActive = key === frameKey;
    frame.classList.toggle('hidden', !isActive);
    frame.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    frame.tabIndex = isActive ? 0 : -1;
  }
}

function postCookieBridgeResponse(
  target: WindowProxy | null,
  message: PreviewCookieResponseMessage,
): void {
  if (!target) {
    return;
  }
  target.postMessage(message, '*');
}

async function handleCookieBridgeRequest(
  event: MessageEvent<unknown>,
  request: PreviewCookieRequestMessage,
): Promise<void> {
  const target = event.source as WindowProxy | null;
  const activePreview = getActivePreview();
  const routeKey = activePreview?.routeKey ?? getActiveDockedClient()?.routeKey ?? null;

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
  if (typeof request.previewName === 'string') {
    responseMessage.previewName = request.previewName;
  }

  if (!routeKey) {
    responseMessage.error = 'No active preview route';
    postCookieBridgeResponse(target, responseMessage);
    return;
  }

  const upstreamUrl =
    typeof request.upstreamUrl === 'string' ? request.upstreamUrl : getActiveUrl();
  const url = new URL(getCookieBridgePath(routeKey), window.location.origin);
  if (upstreamUrl) {
    url.searchParams.set('u', upstreamUrl);
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

/** Load the current active named preview into the iframe. */
export async function loadPreview(): Promise<void> {
  if (!iframeHost) {
    return;
  }

  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  const currentPreview = getActivePreview();
  const currentUrl = currentPreview?.url ?? $webPreviewUrl.get();
  const currentTargetRevision = currentPreview?.targetRevision ?? 0;

  if (!currentUrl || !sessionId) {
    setVisiblePreviewFrame(null);
    loadedUrl = null;
    hideStatusIndicator();
    return;
  }

  const frameKey = getPreviewFrameKey(sessionId, previewName);

  const previewClient = await ensureDockedPreviewClient(sessionId, previewName);
  if ($activeSessionId.get() !== sessionId || getActivePreviewName() !== previewName) {
    return;
  }

  if (!previewClient) {
    setVisiblePreviewFrame(null);
    log.warn(() => `Failed to create browser preview client for ${sessionId}/${previewName}`);
    await refreshBrowserPreviewStatus();
    return;
  }

  const initialFrame = ensurePreviewIframe(sessionId, previewName);
  if (!initialFrame) {
    log.warn(() => `Failed to allocate dock iframe for ${sessionId}/${previewName}`);
    return;
  }

  let frame: HTMLIFrameElement = initialFrame;

  try {
    if (shouldRemountPreviewFrame(frame, previewClient, currentUrl, currentTargetRevision)) {
      const replacementFrame = replacePreviewIframe(frameKey);
      if (!replacementFrame) {
        log.warn(() => `Failed to recreate dock iframe for ${sessionId}/${previewName}`);
        return;
      }
      frame = replacementFrame;
    }

    applyIframeSandbox(previewClient.origin, frame, currentUrl);
    setPreviewContextCookie(previewClient);
    frame.name = JSON.stringify(previewClient);
    const proxyUrl = buildProxyUrl(
      currentUrl,
      previewClient,
      currentTargetRevision,
      previewClient.origin ?? window.location.origin,
    );
    if (shouldReloadPreviewFrame(frame, proxyUrl, currentUrl, currentTargetRevision)) {
      if (frame.src === proxyUrl) {
        frame.src = 'about:blank';
      }
      frame.src = proxyUrl;
    }
    frame.dataset[PREVIEW_LOAD_TOKEN_DATASET_KEY] = buildPreviewLoadToken(
      currentUrl,
      currentTargetRevision,
    );
    setVisiblePreviewFrame(frameKey);
    loadedUrl = currentUrl;
    await refreshBrowserPreviewStatus();
  } catch {
    frame.name = '';
    frame.src = 'about:blank';
    frame.classList.add('hidden');
    frame.removeAttribute(PREVIEW_LOAD_TOKEN_ATTRIBUTE);
    await refreshBrowserPreviewStatus();
  }
}

async function handleRefresh(mode: 'soft' | 'hard' = 'soft'): Promise<void> {
  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  if (!sessionId) {
    return;
  }

  if (mode === 'hard') {
    await clearWebPreviewBrowserStateAsync();
  }

  const currentUrl = getActiveUrl() ?? $webPreviewUrl.get();
  if (currentUrl) {
    const result = await setWebPreviewTarget(sessionId, previewName, currentUrl);
    if (!result?.active) {
      log.warn(() => 'Failed to refresh web preview target');
      return;
    }
    setCurrentPreviewUrl(currentUrl, false);
  }

  await reloadWebPreview(sessionId, previewName, mode);
  await loadPreview();
}

/**
 * Update the URL bar to reflect in-iframe navigation.
 */
function updateUrlBarFromIframe(
  iframeUrl: string,
  upstreamUrl?: string,
  targetOrigin?: string,
): void {
  try {
    const routeKey = getActivePreview()?.routeKey ?? getActiveDockedClient()?.routeKey;
    if (!routeKey) {
      return;
    }
    const displayUrl = upstreamUrl || decodeIframeNavigationUrl(iframeUrl, routeKey, targetOrigin);
    if (!displayUrl) {
      return;
    }
    setCurrentPreviewUrl(displayUrl);
  } catch {
    // ignore malformed URLs
  }
}

/** Show the web preview iframe and hide the detached placeholder. */
export function showIframe(): void {
  const frameKey = getActivePreviewFrameKey();
  if (frameKey) {
    setVisiblePreviewFrame(frameKey);
  }
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) {
    placeholder.classList.add('hidden');
  }
}

/** Hide the web preview iframe. */
export function hideIframe(): void {
  setVisiblePreviewFrame(null);
}

/** Unload the iframe by navigating to about:blank and hiding it. */
export function unloadIframe(sessionId?: string | null, previewName?: string | null): void {
  const frameKey =
    sessionId && previewName
      ? getPreviewFrameKey(sessionId, previewName)
      : getActivePreviewFrameKey();
  if (!frameKey) {
    loadedUrl = null;
    return;
  }

  const frame = previewFrames.get(frameKey);
  if (frame) {
    frame.name = '';
    frame.src = 'about:blank';
    frame.classList.add('hidden');
    frame.removeAttribute(PREVIEW_LOAD_TOKEN_ATTRIBUTE);
  }

  if (activeFrameKey === frameKey) {
    activeFrameKey = null;
    loadedUrl = null;
  }
}

/** Show the detached placeholder message and hide the iframe. */
export function showDetachedPlaceholder(): void {
  hideIframe();
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) {
    placeholder.classList.remove('hidden');
  }
}

/** Hide the detached placeholder message and show the iframe. */
export function hideDetachedPlaceholder(): void {
  const placeholder = document.getElementById('web-preview-detached-msg');
  if (placeholder) {
    placeholder.classList.add('hidden');
  }
  showIframe();
}

/**
 * Inject a chat message into the active terminal telling the agent to read
 * the browser control guidance file.
 */
function handleAgentHint(): void {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    return;
  }

  const fg = getForegroundInfo(sessionId);
  const guidanceFile = getAgentGuidanceFile(fg.name);
  const message = `Read the file ${guidanceFile} for instructions on how to interact with this browser preview.\n`;

  sendInput(sessionId, message);
}

function decodeScreenshotDataUrl(dataUrl: string): Blob | null {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

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
 * Capture a screenshot of the active named web preview.
 */
async function handleScreenshot(download = false): Promise<void> {
  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  const iframe = getActiveIframe();
  if (!sessionId || !iframe || iframe.src === 'about:blank') {
    return;
  }

  const previewId = getActiveDockedClient()?.previewId;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot_${ts}.png`;

  const dataUrl = await captureBrowserScreenshotRaw(sessionId, previewId, previewName);
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
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
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
  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  if (!sessionId) {
    return;
  }

  const ok = await clearWebPreviewCookies(sessionId, previewName);
  if (ok) {
    log.info(() => 'Cookies cleared');
    await loadPreview();
  } else {
    log.warn(() => 'Failed to clear cookies');
    await refreshBrowserPreviewStatus();
  }
}

async function handleClearState(): Promise<void> {
  const sessionId = $activeSessionId.get();
  const previewName = getActivePreviewName();
  if (!sessionId) {
    return;
  }

  const cleared = await clearWebPreviewState(sessionId, previewName);
  if (!cleared) {
    setStatusIndicatorMessage('error', 'Failed to clear the session-scoped preview state.');
    log.warn(() => 'Failed to clear session-scoped preview state');
    await refreshBrowserPreviewStatus();
    return;
  }

  upsertSessionPreview(cleared);
  setCurrentPreviewUrl(cleared.url);

  const browserResult = await runBrowserCommand(
    'clearstate',
    sessionId,
    previewName,
    getActiveDockedClient()?.previewId,
  );

  if (!browserResult?.success) {
    const error =
      browserResult?.error?.trim() ||
      'Server-side preview state was cleared, but browser-side state could not be cleared.';
    setStatusIndicatorMessage(
      'warn',
      `Server-side preview state cleared. Browser-side state could not be fully cleared: ${error}`,
    );
    log.warn(() => `Browser-side clearstate failed: ${error}`);
  } else {
    log.info(() => 'Preview state cleared');
  }

  await loadPreview();
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

function hideStatusIndicator(): void {
  if (!statusIndicator) {
    return;
  }

  statusIndicator.textContent = '!';
  statusIndicator.title = '';
  statusIndicator.classList.add('hidden');
  statusIndicator.dataset.severity = 'info';
  statusIndicator.setAttribute('aria-hidden', 'true');
  statusIndicator.removeAttribute('aria-label');
}

function setStatusIndicatorMessage(severity: 'info' | 'warn' | 'error', message: string): void {
  if (!statusIndicator) {
    return;
  }

  statusIndicator.textContent = '!';
  statusIndicator.title = message;
  statusIndicator.dataset.severity = severity;
  statusIndicator.classList.remove('hidden');
  statusIndicator.setAttribute('aria-hidden', 'false');
  statusIndicator.setAttribute('aria-label', message);
}

async function refreshBrowserPreviewStatus(): Promise<void> {
  const dock = document.getElementById('web-preview-dock');
  if (dock?.classList.contains('hidden')) {
    return;
  }

  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    hideStatusIndicator();
    return;
  }

  const previewName = getActivePreviewName();
  const preview = getActivePreview();
  if (!preview?.url && !getActiveDockedClient()?.previewId) {
    hideStatusIndicator();
    return;
  }

  const status = await getBrowserPreviewStatus(
    sessionId,
    previewName,
    getActiveDockedClient()?.previewId,
  );

  if (!status) {
    setStatusIndicatorMessage(
      'warn',
      'Browser status is currently unavailable, so the dev browser state cannot be verified honestly.',
    );
    return;
  }

  const indicatorState = buildBrowserPreviewStatusIndicatorState(status);
  if (!indicatorState) {
    hideStatusIndicator();
    return;
  }

  setStatusIndicatorMessage(indicatorState.severity, indicatorState.message);
}
