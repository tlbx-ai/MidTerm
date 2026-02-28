/**
 * Mobile Picture-in-Picture Module
 *
 * Provides a mobile-first miniature terminal preview using Document PiP.
 * When the PWA is backgrounded, we attempt to open a floating mini window
 * showing the active terminal and flash it when output heat cools down.
 */

import { MOBILE_BREAKPOINT } from '../../constants';
import { sessionTerminals } from '../../state';
import { $activeSessionId, $sessionList } from '../../stores';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('mobilePiP');

const PREVIEW_LINES = 16;
const PREVIEW_COLS = 88;
const PREVIEW_REFRESH_MS = 1000;
const HEAT_WINDOW_MS = 5000;
const HEAT_IDLE_BPS = 24;
const COOLING_RATIO_THRESHOLD = 0.9;
const FLASH_DURATION_MS = 600;

interface DocumentPictureInPictureWindowOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPictureApi {
  window: Window | null;
  requestWindow(options?: DocumentPictureInPictureWindowOptions): Promise<Window>;
}

interface WindowWithDocumentPictureInPicture extends Window {
  documentPictureInPicture?: DocumentPictureInPictureApi;
}

type HeatTrend = 'idle' | 'up' | 'down' | 'steady';

let initialized = false;
let enabled = false;
let autoPiPDisabled = false;
let pipWindow: Window | null = null;
let pipRoot: HTMLDivElement | null = null;
let pipTitleEl: HTMLDivElement | null = null;
let pipRateEl: HTMLDivElement | null = null;
let pipPreviewEl: HTMLPreElement | null = null;
let previewIntervalId: number | null = null;
let heatIntervalId: number | null = null;
let flashTimeoutId: number | null = null;

let trackedSessionId: string | null = null;
let heatWindowBytes = 0;
let lastHeatTickMs = performance.now();
let lastHeatBps = 0;
let currentHeatBps = 0;
let heatTrend: HeatTrend = 'idle';

/**
 * Initialize mobile PiP behavior.
 * Safe to call multiple times.
 */
export function initMobilePiP(): void {
  if (initialized) return;
  initialized = true;
  enabled = isMobileContext();
  if (!enabled) return;

  trackedSessionId = $activeSessionId.get();
  resetHeatTracking(trackedSessionId);

  if ('mediaSession' in navigator) {
    try {
      // TypeScript's MediaSessionAction type lags behind the spec — cast required.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator.mediaSession as any).setActionHandler('enterpictureinpicture', () => {
        void openPiPIfEligibleAsync();
      });
    } catch {
      // Browser doesn't support this action handler — PiP from visibilitychange won't work.
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handlePageShow);

  $activeSessionId.subscribe((sessionId) => {
    trackedSessionId = sessionId;
    resetHeatTracking(sessionId);
    updatePiPContent();
  });

  $sessionList.subscribe(() => {
    updatePiPContent();
  });

  if (heatIntervalId === null) {
    heatIntervalId = window.setInterval(onHeatWindowTick, HEAT_WINDOW_MS);
  }
}

/**
 * Record output bytes for active-session heat tracking.
 * Called from mux output callback wiring in main.ts.
 */
export function recordMobilePiPBytes(sessionId: string, bytes: number): void {
  if (!enabled) return;
  if (bytes <= 0) return;
  if (trackedSessionId === null || sessionId !== trackedSessionId) return;
  heatWindowBytes += bytes;
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    void openPiPIfEligibleAsync();
  } else {
    autoPiPDisabled = false;
    closePiPWindow();
  }
}

function handlePageShow(): void {
  autoPiPDisabled = false;
  closePiPWindow();
}

function getDocumentPiPApi(): DocumentPictureInPictureApi | null {
  const w = window as WindowWithDocumentPictureInPicture;
  return w.documentPictureInPicture ?? null;
}

function isMobileContext(): boolean {
  return (
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches || navigator.maxTouchPoints > 0
  );
}

function shouldOpenPiP(): boolean {
  return isMobileContext();
}

async function openPiPIfEligibleAsync(): Promise<void> {
  if (pipWindow !== null) return;
  if (autoPiPDisabled) return;
  if (!shouldOpenPiP()) return;

  const pipApi = getDocumentPiPApi();
  if (pipApi === null) return;

  try {
    const win = await pipApi.requestWindow({
      width: 430,
      height: 260,
      preferInitialWindowPlacement: true,
    });

    if (document.visibilityState !== 'hidden') {
      win.close();
      return;
    }

    attachPiPWindow(win);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotSupportedError') {
      autoPiPDisabled = true;
    }
    log.info(() => `Mobile PiP failed: ${String(error)}`);
  }
}

function attachPiPWindow(win: Window): void {
  pipWindow = win;
  buildPiPDocument(win.document);
  win.addEventListener('pagehide', clearPiPReferences);
  startPreviewLoop();
  updatePiPContent();
  applyHeatUi();
}

function buildPiPDocument(doc: Document): void {
  doc.head.innerHTML = '';
  doc.body.innerHTML = '';

  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.appendChild(meta);

  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width,initial-scale=1';
  doc.head.appendChild(viewport);

  const style = doc.createElement('style');
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: #070a11;
      color: #d8deeb;
    }

    .mm-mobile-pip {
      box-sizing: border-box;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      border: 2px solid #1f2c45;
      border-radius: 12px;
      background: linear-gradient(180deg, #0f1627 0%, #070a11 100%);
      overflow: hidden;
    }

    .mm-mobile-pip__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #1f2c45;
      background: rgba(11, 18, 33, 0.9);
      font-size: 12px;
    }

    .mm-mobile-pip__title {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #f1f5ff;
      font-weight: 600;
    }

    .mm-mobile-pip__rate {
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      color: #9ea8ba;
    }

    .mm-mobile-pip__preview {
      margin: 0;
      flex: 1;
      padding: 10px;
      line-height: 1.25;
      font-size: 11px;
      overflow: hidden;
      white-space: pre;
      text-overflow: clip;
      color: #d8deeb;
    }

    .mm-mobile-pip.heat-up .mm-mobile-pip__rate {
      color: #9adf70;
    }

    .mm-mobile-pip.heat-down .mm-mobile-pip__rate {
      color: #f4d07c;
    }

    .mm-mobile-pip.heat-idle .mm-mobile-pip__rate {
      color: #94a3b8;
    }

    .mm-mobile-pip.cooling-flash {
      animation: mm-mobile-pip-flash 0.6s ease-out;
    }

    @keyframes mm-mobile-pip-flash {
      0% {
        box-shadow: 0 0 0 0 rgba(244, 208, 124, 0.9);
        border-color: #f4d07c;
      }
      100% {
        box-shadow: 0 0 0 12px rgba(244, 208, 124, 0);
        border-color: #1f2c45;
      }
    }
  `;
  doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.className = 'mm-mobile-pip heat-idle';

  const header = doc.createElement('div');
  header.className = 'mm-mobile-pip__header';

  const title = doc.createElement('div');
  title.className = 'mm-mobile-pip__title';
  title.textContent = t('terminal.noTerminals');

  const rate = doc.createElement('div');
  rate.className = 'mm-mobile-pip__rate';
  rate.textContent = '. 0 B/s';

  header.appendChild(title);
  header.appendChild(rate);

  const preview = doc.createElement('pre');
  preview.className = 'mm-mobile-pip__preview';
  preview.textContent = '';

  root.appendChild(header);
  root.appendChild(preview);
  doc.body.appendChild(root);

  pipRoot = root;
  pipTitleEl = title;
  pipRateEl = rate;
  pipPreviewEl = preview;
}

function startPreviewLoop(): void {
  if (previewIntervalId !== null) return;
  previewIntervalId = window.setInterval(updatePiPContent, PREVIEW_REFRESH_MS);
}

function closePiPWindow(): void {
  const win = pipWindow;
  clearPiPReferences();
  if (win !== null && !win.closed) {
    try {
      win.close();
    } catch {
      // Ignored: close can throw when window is already closing.
    }
  }
}

function clearPiPReferences(): void {
  if (previewIntervalId !== null) {
    window.clearInterval(previewIntervalId);
    previewIntervalId = null;
  }
  if (flashTimeoutId !== null) {
    window.clearTimeout(flashTimeoutId);
    flashTimeoutId = null;
  }
  pipWindow = null;
  pipRoot = null;
  pipTitleEl = null;
  pipRateEl = null;
  pipPreviewEl = null;
}

function updatePiPContent(): void {
  if (pipTitleEl === null || pipPreviewEl === null) return;

  const activeSessionId = $activeSessionId.get();
  if (activeSessionId === null) {
    pipTitleEl.textContent = t('terminal.noTerminals');
    pipPreviewEl.textContent = '';
    return;
  }

  const session = $sessionList.get().find((s) => s.id === activeSessionId);
  pipTitleEl.textContent =
    session?.name ?? session?.terminalTitle ?? session?.shellType ?? t('session.terminal');
  pipPreviewEl.textContent = buildTerminalPreview(activeSessionId);
}

function buildTerminalPreview(sessionId: string): string {
  const state = sessionTerminals.get(sessionId);
  if (!state?.terminal) {
    return t('terminal.noTerminals');
  }

  const terminal = state.terminal;
  const buffer = terminal.buffer.active;
  const endLine = buffer.baseY + terminal.rows;
  const startLine = Math.max(0, endLine - PREVIEW_LINES);
  const lines: string[] = [];

  for (let lineIndex = startLine; lineIndex < endLine; lineIndex++) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      lines.push('');
      continue;
    }
    let text = line.translateToString(true);
    if (text.length > PREVIEW_COLS) {
      text = text.slice(text.length - PREVIEW_COLS);
    }
    lines.push(text);
  }

  return lines.join('\n');
}

function resetHeatTracking(sessionId: string | null): void {
  trackedSessionId = sessionId;
  heatWindowBytes = 0;
  lastHeatTickMs = performance.now();
  lastHeatBps = 0;
  currentHeatBps = 0;
  heatTrend = 'idle';
  applyHeatUi();
}

function onHeatWindowTick(): void {
  const elapsedMs = Math.max(1, performance.now() - lastHeatTickMs);
  lastHeatTickMs = performance.now();

  currentHeatBps = (heatWindowBytes / elapsedMs) * 1000;
  heatWindowBytes = 0;

  if (currentHeatBps <= HEAT_IDLE_BPS) {
    heatTrend = 'idle';
  } else if (lastHeatBps <= HEAT_IDLE_BPS) {
    heatTrend = 'up';
  } else if (currentHeatBps < lastHeatBps * COOLING_RATIO_THRESHOLD) {
    heatTrend = 'down';
  } else if (currentHeatBps > lastHeatBps * 1.1) {
    heatTrend = 'up';
  } else {
    heatTrend = 'steady';
  }

  if (heatTrend === 'down' && pipWindow !== null) {
    flashPiP();
  }

  lastHeatBps = currentHeatBps;
  applyHeatUi();
}

function applyHeatUi(): void {
  if (pipRoot === null || pipRateEl === null) return;

  pipRoot.classList.remove('heat-idle', 'heat-up', 'heat-down', 'heat-steady');
  if (heatTrend === 'idle') {
    pipRoot.classList.add('heat-idle');
    pipRateEl.textContent = `. ${formatRate(currentHeatBps)}`;
    return;
  }
  if (heatTrend === 'up') {
    pipRoot.classList.add('heat-up');
    pipRateEl.textContent = `^ ${formatRate(currentHeatBps)}`;
    return;
  }
  if (heatTrend === 'down') {
    pipRoot.classList.add('heat-down');
    pipRateEl.textContent = `v ${formatRate(currentHeatBps)}`;
    return;
  }
  pipRoot.classList.add('heat-steady');
  pipRateEl.textContent = `- ${formatRate(currentHeatBps)}`;
}

function flashPiP(): void {
  if (pipRoot === null) return;

  pipRoot.classList.remove('cooling-flash');
  void pipRoot.offsetWidth;
  pipRoot.classList.add('cooling-flash');

  if (flashTimeoutId !== null) {
    window.clearTimeout(flashTimeoutId);
  }
  flashTimeoutId = window.setTimeout(() => {
    pipRoot?.classList.remove('cooling-flash');
    flashTimeoutId = null;
  }, FLASH_DURATION_MS);
}

function formatRate(bps: number): string {
  if (bps < 1) return '0 B/s';
  if (bps < 1000) return `${Math.round(bps)} B/s`;
  if (bps < 1000000) return `${(bps / 1000).toFixed(1)} KB/s`;
  return `${(bps / 1000000).toFixed(2)} MB/s`;
}
