/**
 * Terminal Scaling Module
 *
 * Handles terminal scaling, fitting to screen, and viewport resize handling.
 * Terminals maintain server-side dimensions and are scaled to fit the viewport.
 */

import type { TerminalState } from '../../types';
import {
  TERMINAL_PADDING,
  SCROLLBAR_WIDTH,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  icon,
} from '../../constants';
import { sessionTerminals, fontsReadyPromise, dom } from '../../state';
import {
  $activeSessionId,
  $currentSettings,
  $isMainBrowser,
  $sessions,
  getSession,
} from '../../stores';
import { throttle } from '../../utils';
import { getCalibrationMeasurement, getCalibrationPromise, focusActiveTerminal } from './manager';
import { isTerminalVisible, refreshTerminalRenderer } from './presentationRefresh';
import {
  buildTerminalFontStack,
  DEFAULT_TERMINAL_FONT_WEIGHT,
  DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
  DEFAULT_TERMINAL_LETTER_SPACING,
  DEFAULT_TERMINAL_LINE_HEIGHT,
  ensureTerminalFontLoaded,
  getConfiguredTerminalFontFamily,
} from './fontConfig';
import { claimMainBrowser, sendResize } from '../comms';
import { t } from '../i18n';
import { isDevMode } from '../sidebar/voiceSection';
import { getTabBarHeight } from '../sessionTabs';

const SCALE_TOLERANCE = 0.97;
const MAX_TRANSIENT_FIT_RETRIES = 2;

type MeasurementSource = 'existing-terminal' | 'calibration' | 'font-probe' | 'xterm-internal';

export function isTerminalViewingScrollback(state: Pick<TerminalState, 'terminal'>): boolean {
  const buffer = state.terminal.buffer.active;
  return buffer.viewportY < buffer.baseY;
}

export function refreshTerminalPresentation(
  _sessionId: string,
  providedState?: TerminalState,
): void {
  const state = providedState ?? sessionTerminals.get(_sessionId);
  if (!state) return;

  if (!state.opened || !isTerminalVisible(state)) {
    state.pendingVisualRefresh = true;
    return;
  }

  state.pendingVisualRefresh = false;

  requestAnimationFrame(() => {
    const currentState = providedState ?? sessionTerminals.get(_sessionId);
    if (!currentState?.opened) return;

    if (!isTerminalVisible(currentState)) {
      currentState.pendingVisualRefresh = true;
      return;
    }

    refreshTerminalRenderer(currentState);
  });
}

/**
 * Get the total width of all visible dock panels.
 * Web preview can coexist with one other dock (commands, git, or file viewer).
 */
function getDockPanelWidth(): number {
  let total = 0;
  for (const id of ['git-dock', 'commands-dock', 'file-viewer-dock', 'web-preview-dock']) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) total += el.offsetWidth;
  }
  return total;
}

/**
 * Get cell dimensions from xterm.js internal render service.
 * These are the true cell sizes unaffected by CSS layout constraints,
 * avoiding circular measurements when the terminal overflows its container.
 */
function getXtermCellDimensions(
  terminal: TerminalState['terminal'],
): { cellWidth: number; cellHeight: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = terminal as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const dims = core._core?._renderService?.dimensions?.css?.cell as
    | { width: number; height: number }
    | undefined;
  if (!dims || dims.width < 1 || dims.height < 1) return null;
  return { cellWidth: dims.width, cellHeight: dims.height };
}

function measureTerminalCellDimensions(
  state: Pick<TerminalState, 'terminal' | 'container'>,
): { cellWidth: number; cellHeight: number } | null {
  const xtermDims = getXtermCellDimensions(state.terminal);
  if (xtermDims) {
    return xtermDims;
  }

  const screen = state.container.querySelector<HTMLElement>('.xterm-screen');
  const terminalCols = state.terminal.cols;
  const terminalRows = state.terminal.rows;
  if (!screen || terminalCols <= 0 || terminalRows <= 0) {
    return null;
  }

  const cellWidth = screen.offsetWidth / terminalCols;
  const cellHeight = screen.offsetHeight / terminalRows;
  if (cellWidth < 1 || cellHeight < 1) {
    return null;
  }

  return { cellWidth, cellHeight };
}

function calculateOptimalDimensionsForViewport(
  state: Pick<TerminalState, 'terminal' | 'container'>,
  container: HTMLElement,
  isLayoutPane: boolean,
): { cols: number; rows: number } | null {
  const cellDims = measureTerminalCellDimensions(state);
  if (!cellDims) {
    return null;
  }

  const rect = container.getBoundingClientRect();
  const tabBarH = isLayoutPane ? 0 : getTabBarHeight();
  const dockWidth = isLayoutPane ? 0 : getDockPanelWidth();
  const availWidth = rect.width - TERMINAL_PADDING - SCROLLBAR_WIDTH - dockWidth;
  const availHeight = rect.height - TERMINAL_PADDING - tabBarH;

  if (availWidth <= 0 || availHeight <= 0) {
    return null;
  }

  let cols = Math.floor(availWidth / cellDims.cellWidth);
  let rows = Math.floor(availHeight / cellDims.cellHeight);
  cols = Math.max(MIN_TERMINAL_COLS, Math.min(cols, MAX_TERMINAL_COLS));
  rows = Math.max(MIN_TERMINAL_ROWS, Math.min(rows, MAX_TERMINAL_ROWS));
  return { cols, rows };
}

export function getTerminalViewportMismatch(
  state: Pick<TerminalState, 'terminal' | 'container'>,
): { optimalCols: number; optimalRows: number; isTooLarge: boolean; isTooSmall: boolean } | null {
  const layoutPane = state.container.closest<HTMLElement>('.layout-leaf');
  const viewportContainer = layoutPane ?? dom.terminalsArea;
  if (!viewportContainer) {
    return null;
  }

  const optimal = calculateOptimalDimensionsForViewport(state, viewportContainer, !!layoutPane);
  if (!optimal) {
    return null;
  }

  return {
    optimalCols: optimal.cols,
    optimalRows: optimal.rows,
    isTooLarge: state.terminal.cols > optimal.cols || state.terminal.rows > optimal.rows,
    isTooSmall: state.terminal.cols < optimal.cols || state.terminal.rows < optimal.rows,
  };
}

function logResizeDiagnostics(
  operation: 'create' | 'manual-resize',
  sessionId: string,
  container: HTMLElement,
  fontFamily: string,
  fontSize: number,
  cellWidth: number,
  cellHeight: number,
  measurementSource: MeasurementSource,
  cols: number,
  rows: number,
  state?: TerminalState,
): void {
  const session = getSession(sessionId);
  const containerRect = container.getBoundingClientRect();

  const assumedWidth = cols * cellWidth;
  const assumedHeight = rows * cellHeight;

  let actualWidth = 0;
  let actualHeight = 0;
  let scaleFactor = 1;

  if (state?.opened) {
    const xterm = state.container.querySelector<HTMLElement>('.xterm');
    const screen = state.container.querySelector<HTMLElement>('.xterm-screen');
    if (xterm && screen) {
      actualWidth = screen.offsetWidth;
      actualHeight = screen.offsetHeight;
      const availW = state.container.clientWidth - TERMINAL_PADDING;
      const availH = state.container.clientHeight - TERMINAL_PADDING;
      const scaleX = availW / xterm.offsetWidth;
      const scaleY = availH / xterm.offsetHeight;
      scaleFactor = Math.min(scaleX, scaleY, 1);
    }
  }

  if (localStorage.getItem('latency-overlay-enabled') === 'true') {
    // eslint-disable-next-line no-console
    console.log(
      `[RESIZE DIAG] ${operation}\n` +
        `  Session: "${session?.name ?? sessionId}" (${session?.terminalTitle ?? 'no title'})\n` +
        `  Container: ${containerRect.width.toFixed(0)}×${containerRect.height.toFixed(0)} px\n` +
        `  Font: ${fontFamily}, ${fontSize}px\n` +
        `  Cell size: ${cellWidth.toFixed(2)}×${cellHeight.toFixed(2)} px (from: ${measurementSource})\n` +
        `  Calculated fit: ${cols}×${rows}\n` +
        `  Assumed size: ${assumedWidth.toFixed(0)}×${assumedHeight.toFixed(0)} px\n` +
        `  Actual size: ${actualWidth.toFixed(0)}×${actualHeight.toFixed(0)} px\n` +
        `  Scale factor: ${scaleFactor.toFixed(3)}`,
    );
  }
}

/**
 * Measure actual cell dimensions from an existing terminal.
 * Returns null if no terminal is available or measurements are invalid.
 */
function measureFromExistingTerminal(
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
  letterSpacing: number,
  fontWeight: string,
  fontWeightBold: string,
): { cellWidth: number; cellHeight: number } | null {
  const expectedFontStack = buildTerminalFontStack(fontFamily);

  for (const state of sessionTerminals.values()) {
    if (!state.opened) continue;

    // Only trust measurements from terminals using the same font size we plan to apply.
    if (state.terminal.options.fontSize !== fontSize) continue;
    if ((state.terminal.options.lineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT) !== lineHeight)
      continue;
    if (
      (state.terminal.options.letterSpacing ?? DEFAULT_TERMINAL_LETTER_SPACING) !== letterSpacing
    ) {
      continue;
    }
    if (String(state.terminal.options.fontWeight ?? DEFAULT_TERMINAL_FONT_WEIGHT) !== fontWeight) {
      continue;
    }
    if (
      String(state.terminal.options.fontWeightBold ?? DEFAULT_TERMINAL_FONT_WEIGHT_BOLD) !==
      fontWeightBold
    ) {
      continue;
    }
    const terminalFontFamily = state.terminal.options.fontFamily ?? '';
    if (terminalFontFamily !== expectedFontStack && !terminalFontFamily.includes(fontFamily)) {
      continue;
    }

    // Prefer xterm.js internal dimensions (accurate, not affected by CSS layout)
    const xtermDims = getXtermCellDimensions(state.terminal);
    if (xtermDims) return xtermDims;

    // Fallback to DOM measurement
    const screen = state.container.querySelector<HTMLElement>('.xterm-screen');
    const cols = state.terminal.cols;
    const rows = state.terminal.rows;

    if (screen && cols > 0 && rows > 0) {
      const cellWidth = screen.offsetWidth / cols;
      const cellHeight = screen.offsetHeight / rows;

      if (cellWidth >= 1 && cellHeight >= 1) {
        return { cellWidth, cellHeight };
      }
    }
  }
  return null;
}

/**
 * Measure cell dimensions by creating a temporary element with the terminal font.
 * Used when no existing terminal is available to measure from.
 */
function measureFromFont(
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
  letterSpacing: number,
  fontWeight: string,
): { cellWidth: number; cellHeight: number } {
  const measureEl = document.createElement('span');
  measureEl.style.cssText = `
    position: absolute;
    visibility: hidden;
    font-family: ${buildTerminalFontStack(fontFamily)};
    font-size: ${fontSize}px;
    line-height: ${lineHeight};
    letter-spacing: ${letterSpacing}px;
    font-weight: ${fontWeight};
    white-space: pre;
  `;
  measureEl.textContent = 'WWWWWWWWWW';
  document.body.appendChild(measureEl);

  const cellWidth = measureEl.offsetWidth / 10;
  const cellHeight = measureEl.offsetHeight;

  document.body.removeChild(measureEl);

  return { cellWidth, cellHeight };
}

/**
 * Calculate optimal terminal dimensions (cols/rows) for the given container.
 * Uses actual font measurements - either from existing terminal or by measuring the font directly.
 *
 * This is the SINGLE source of truth for size calculations used by:
 * - Session creation (main.ts)
 * - Fit-to-screen (scaling.ts)
 */
export async function calculateOptimalDimensions(
  container: HTMLElement,
  fontSize: number,
  fontFamily: string,
  lineHeight: number = DEFAULT_TERMINAL_LINE_HEIGHT,
  letterSpacing: number = DEFAULT_TERMINAL_LETTER_SPACING,
  fontWeight: string = DEFAULT_TERMINAL_FONT_WEIGHT,
  fontWeightBold: string = DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
  sessionIdForLog?: string,
): Promise<{ cols: number; rows: number } | null> {
  // Allow layout to settle for very small containers before giving up
  let rect = container.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    rect = container.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
      return null;
    }
  }

  // Get cell dimensions - priority order:
  // 1. Existing open terminal (most accurate, already rendered)
  // 2. Calibration measurement (accurate, from hidden terminal at startup)
  // 3. Font probe (fallback, less accurate)
  const existingMeasurement = measureFromExistingTerminal(
    fontSize,
    fontFamily,
    lineHeight,
    letterSpacing,
    fontWeight,
    fontWeightBold,
  );

  let measurementSource: MeasurementSource;
  let cellWidth: number;
  let cellHeight: number;

  if (existingMeasurement) {
    measurementSource = 'existing-terminal';
    cellWidth = existingMeasurement.cellWidth;
    cellHeight = existingMeasurement.cellHeight;
  } else {
    // Wait for calibration to complete if it's running
    const calibrationPromise = getCalibrationPromise();
    if (calibrationPromise) {
      await calibrationPromise;
    }

    const calibration = getCalibrationMeasurement();
    if (
      calibration &&
      calibration.fontSize === fontSize &&
      calibration.lineHeight === lineHeight &&
      calibration.letterSpacing === letterSpacing &&
      calibration.fontWeight === fontWeight &&
      calibration.fontWeightBold === fontWeightBold &&
      (calibration.fontFamily === buildTerminalFontStack(fontFamily) ||
        calibration.fontFamily.includes(fontFamily))
    ) {
      measurementSource = 'calibration';
      cellWidth = calibration.cellWidth;
      cellHeight = calibration.cellHeight;
    } else {
      // Fallback to font probe (inaccurate but better than nothing)
      measurementSource = 'font-probe';
      if (fontsReadyPromise) {
        await fontsReadyPromise;
      }
      await ensureTerminalFontLoaded(fontFamily, fontSize);
      const fontMeasurement = measureFromFont(
        fontSize,
        fontFamily,
        lineHeight,
        letterSpacing,
        fontWeight,
      );
      cellWidth = fontMeasurement.cellWidth;
      cellHeight = fontMeasurement.cellHeight;
    }
  }

  // Account for padding, scrollbar width, session tab bar, and dock panels
  const tabBarH = getTabBarHeight();
  const dockWidth = getDockPanelWidth();
  const availWidth = rect.width - TERMINAL_PADDING - SCROLLBAR_WIDTH - dockWidth;
  const availHeight = rect.height - TERMINAL_PADDING - tabBarH;

  const cols = Math.floor(availWidth / cellWidth);
  const rows = Math.floor(availHeight / cellHeight);

  // Clamp to valid range
  const clampedCols = Math.max(MIN_TERMINAL_COLS, Math.min(cols, MAX_TERMINAL_COLS));
  const clampedRows = Math.max(MIN_TERMINAL_ROWS, Math.min(rows, MAX_TERMINAL_ROWS));

  // Reject only if we cannot reach the minimum, not when we exactly equal it.
  if (clampedCols < MIN_TERMINAL_COLS || clampedRows < MIN_TERMINAL_ROWS) {
    return null;
  }

  if (sessionIdForLog) {
    logResizeDiagnostics(
      'create',
      sessionIdForLog,
      container,
      fontFamily,
      fontSize,
      cellWidth,
      cellHeight,
      measurementSource,
      clampedCols,
      clampedRows,
    );
  }

  return { cols: clampedCols, rows: clampedRows };
}

function refreshRendererForMeasurement(
  state: Pick<TerminalState, 'terminal' | 'container' | 'opened'>,
): void {
  if (!state.opened || !isTerminalVisible(state)) {
    return;
  }

  refreshTerminalRenderer(state);
}

function clearTerminalScaling(state: Pick<TerminalState, 'container'>): void {
  const xterm = state.container.querySelector<HTMLElement>('.xterm');
  if (!xterm) {
    return;
  }

  xterm.style.transform = '';
  xterm.style.transformOrigin = '';
  state.container.classList.remove('scaled');
}

function calculateViewportFit(
  state: Pick<TerminalState, 'terminal' | 'container'>,
  container: HTMLElement,
  isLayoutPane: boolean,
): { cols: number; rows: number; cellWidth: number; cellHeight: number } | null {
  const rect = container.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) {
    return null;
  }

  const measuredCellDims = measureTerminalCellDimensions(state);
  const cellWidth = measuredCellDims?.cellWidth ?? null;
  const cellHeight = measuredCellDims?.cellHeight ?? null;
  if (!cellWidth || !cellHeight || cellWidth < 1 || cellHeight < 1) {
    return null;
  }

  const tabBarH = isLayoutPane ? 0 : getTabBarHeight();
  const dockWidth = isLayoutPane ? 0 : getDockPanelWidth();
  const availWidth = rect.width - TERMINAL_PADDING - SCROLLBAR_WIDTH - dockWidth;
  const availHeight = rect.height - TERMINAL_PADDING - tabBarH;
  if (availWidth <= 0 || availHeight <= 0) {
    return null;
  }

  let cols = Math.floor(availWidth / cellWidth);
  let rows = Math.floor(availHeight / cellHeight);
  cols = Math.max(MIN_TERMINAL_COLS, Math.min(cols, MAX_TERMINAL_COLS));
  rows = Math.max(MIN_TERMINAL_ROWS, Math.min(rows, MAX_TERMINAL_ROWS));

  return { cols, rows, cellWidth, cellHeight };
}

function scheduleFitRetry(sessionId: string, retriesRemaining: number): void {
  if (retriesRemaining <= 0) {
    return;
  }

  requestAnimationFrame(() => {
    const state = sessionTerminals.get(sessionId);
    if (!state) {
      return;
    }

    const layoutPane = state.container.closest<HTMLElement>('.layout-leaf');
    if (layoutPane) {
      fitTerminalToContainerInternal(sessionId, layoutPane, retriesRemaining - 1);
    } else {
      fitSessionToScreenInternal(sessionId, retriesRemaining - 1);
    }
  });
}

/**
 * Fit a session's terminal to the current screen size.
 * This sends a resize request to the server.
 *
 * Uses direct measurement of terminalsArea via getBoundingClientRect() rather than
 * FitAddon's measurement of the terminal container. This avoids timing issues where
 * clearing zoom/scale causes layout to be in flux when measurements occur.
 */
export function fitSessionToScreen(sessionId: string): void {
  fitSessionToScreenInternal(sessionId, MAX_TRANSIENT_FIT_RETRIES);
}

function fitSessionToScreenInternal(sessionId: string, retriesRemaining: number): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  if (!$isMainBrowser.get()) {
    applyTerminalScaling(sessionId, state);
    return;
  }

  // Capture fontSize for diagnostics
  const fontSize = $currentSettings.get()?.fontSize ?? 14;
  const fontFamily = getConfiguredTerminalFontFamily();

  // Wait for terminal to be opened before fitting
  if (!state.opened) {
    void (fontsReadyPromise ?? Promise.resolve()).then(() => {
      fitSessionToScreen(sessionId);
    });
    return;
  }

  // Clear any existing scaling first
  clearTerminalScaling(state);

  // Ensure terminal is visible for accurate measurement
  const wasHidden = state.container.classList.contains('hidden');
  if (wasHidden) {
    state.container.classList.remove('hidden');
  }

  // Use terminalsArea for measurement
  if (!dom.terminalsArea) {
    if (wasHidden) {
      state.container.classList.add('hidden');
    }
    return;
  }

  refreshRendererForMeasurement(state);

  const fit = calculateViewportFit(state, dom.terminalsArea, false);
  if (!fit) {
    if (wasHidden) {
      state.container.classList.add('hidden');
    }
    scheduleFitRetry(sessionId, retriesRemaining);
    return;
  }

  const { cols, rows, cellWidth, cellHeight } = fit;

  // Resize terminal and notify server (synchronous — xterm reflows immediately,
  // offsetWidth forces layout so scaling check gets accurate measurements)
  try {
    if (state.terminal.cols !== cols || state.terminal.rows !== rows) {
      state.terminal.resize(cols, rows);
      sendResize(sessionId, state.terminal.cols, state.terminal.rows);
    }
  } catch {
    // Resize may fail if terminal is disposed
  }

  applyTerminalScalingSync(state);

  logResizeDiagnostics(
    'manual-resize',
    sessionId,
    dom.terminalsArea,
    fontFamily,
    fontSize,
    cellWidth,
    cellHeight,
    'existing-terminal',
    cols,
    rows,
    state,
  );

  if (wasHidden) {
    state.container.classList.add('hidden');
  }
  focusActiveTerminal();
}

/**
 * Fit a terminal to a specific container (e.g., layout pane).
 * Resizes the terminal (cols/rows) and notifies the server.
 * Used when docking terminals into a layout.
 */
export function fitTerminalToContainer(sessionId: string, container: HTMLElement): void {
  fitTerminalToContainerInternal(sessionId, container, MAX_TRANSIENT_FIT_RETRIES);
}

function fitTerminalToContainerInternal(
  sessionId: string,
  container: HTMLElement,
  retriesRemaining: number,
): void {
  const state = sessionTerminals.get(sessionId);
  if (!state || !state.opened) return;

  if (!$isMainBrowser.get()) {
    applyTerminalScaling(sessionId, state);
    return;
  }

  refreshRendererForMeasurement(state);

  const fit = calculateViewportFit(state, container, true);
  if (!fit) {
    scheduleFitRetry(sessionId, retriesRemaining);
    return;
  }

  const { cols, rows } = fit;

  // Resize terminal and notify server
  try {
    if (state.terminal.cols !== cols || state.terminal.rows !== rows) {
      state.terminal.resize(cols, rows);
      state.serverCols = cols;
      state.serverRows = rows;
      sendResize(sessionId, state.terminal.cols, state.terminal.rows);
    }
  } catch {
    // Resize may fail if terminal is disposed
  }

  // Clear any scaling since we just resized to fit
  clearTerminalScaling(state);
  const overlay = state.container.querySelector<HTMLElement>('.scaled-overlay');
  if (overlay) overlay.remove();
}

/**
 * Apply CSS scaling to a terminal synchronously.
 * Use this when already inside a requestAnimationFrame callback.
 */
export function applyTerminalScalingSync(state: TerminalState): void {
  const container = state.container;
  const xterm = container.querySelector<HTMLElement>('.xterm');
  if (!xterm) return;
  const isMainBrowser = $isMainBrowser.get();

  const viewportMismatch = getTerminalViewportMismatch(state);
  const hasOptimalSizeMismatch = !!viewportMismatch?.isTooLarge || !!viewportMismatch?.isTooSmall;

  const availWidth = container.clientWidth - TERMINAL_PADDING;
  const availHeight = container.clientHeight - TERMINAL_PADDING;
  const termWidth = xterm.offsetWidth;
  const termHeight = xterm.offsetHeight;

  if (availWidth <= 0 || availHeight <= 0 || termWidth <= 0 || termHeight <= 0) return;

  // Calculate scale (shrink only, never enlarge)
  const scaleX = availWidth / termWidth;
  const scaleY = availHeight / termHeight;
  let scale = Math.min(scaleX, scaleY, 1);

  // Treat small differences as perfect fit (3% tolerance for rendering variance)
  if (!hasOptimalSizeMismatch && scale > SCALE_TOLERANCE) {
    scale = 1;
  }

  // Find or create overlay element
  let overlay = container.querySelector<HTMLButtonElement>('.scaled-overlay');

  // Helper: ensure overlay exists with click handler
  const ensureOverlay = (): HTMLButtonElement => {
    if (overlay) return overlay;
    overlay = document.createElement('button');
    overlay.className = 'scaled-overlay';
    overlay.type = 'button';
    overlay.addEventListener('click', () => {
      if (!$isMainBrowser.get()) {
        claimMainBrowser();
        return;
      }
      const sessionId = container.id.replace('terminal-', '');
      if (!sessionId) return;
      const layoutPane = container.closest<HTMLElement>('.layout-leaf');
      if (layoutPane) {
        fitTerminalToContainer(sessionId, layoutPane);
      } else {
        fitSessionToScreen(sessionId);
      }
    });
    container.appendChild(overlay);
    return overlay;
  };

  const setOverlayCopy = (el: HTMLButtonElement, label: string): void => {
    const title = isMainBrowser
      ? t('terminal.resizeToThisViewport')
      : t('terminal.makeReferenceScaleBrowser');
    el.title = title;
    el.setAttribute('aria-label', title);
    el.innerHTML = `${icon('resize')} ${label}`;
  };

  // Helper: position overlay above connection-status badge when it's visible
  const positionOverlay = (el: HTMLButtonElement): void => {
    const connBadge = document.getElementById('connection-status');
    const connVisible =
      connBadge &&
      (connBadge.classList.contains('disconnected') ||
        connBadge.classList.contains('reconnecting') ||
        connBadge.classList.contains('connecting'));
    el.style.bottom = connVisible ? '36px' : '8px';
  };

  if (scale < 1) {
    if (isMainBrowser) {
      // The leading browser owns the authoritative terminal size. Never leave
      // it visually scaled; recover by resizing instead.
      xterm.style.transform = '';
      xterm.style.transformOrigin = '';
      container.classList.remove('scaled');
      if (overlay) {
        overlay.remove();
      }
      if (hasOptimalSizeMismatch) {
        scheduleMainBrowserResize();
      }
      return;
    }

    // Too big — scale down (flexbox centers automatically)
    xterm.style.transform = `scale(${scale})`;
    xterm.style.transformOrigin = 'center center';
    container.classList.add('scaled');

    const el = ensureOverlay();
    positionOverlay(el);

    const pct = Math.round(scale * 100);
    const screen = container.querySelector<HTMLElement>('.xterm-screen');
    let diagHtml = '';
    if (isDevMode() && screen) {
      const cols = state.terminal.cols;
      const rows = state.terminal.rows;
      const cellW = (screen.offsetWidth / cols).toFixed(2);
      const cellH = (screen.offsetHeight / rows).toFixed(2);
      const termPx = `${screen.offsetWidth}×${screen.offsetHeight}`;
      const containerPx = `${container.clientWidth}×${container.clientHeight}`;
      const scaleTxt = scale.toPrecision(5);
      diagHtml = `<br><span style="font-size:9pt">Cell: ${cellW}×${cellH}  Term: ${cols}×${rows}  Px: ${termPx}  Container: ${containerPx}  Scale: ${scaleTxt}</span>`;
    }
    const overlayLabel = $isMainBrowser.get()
      ? `${t('terminal.scaledTo')} ${pct}%`
      : `${t('terminal.scaledContent')} (${pct}%) - ${t('terminal.makeReferenceScaleBrowser')}`;
    setOverlayCopy(el, `${overlayLabel}${diagHtml}`);
  } else if (
    viewportMismatch?.isTooSmall ||
    termWidth < availWidth - 2 ||
    termHeight < availHeight - 2
  ) {
    // Fits but undersized — no transform, flexbox centers it
    xterm.style.transform = '';
    xterm.style.transformOrigin = '';
    container.classList.remove('scaled');

    if (viewportMismatch?.isTooSmall) {
      if (isMainBrowser) {
        if (overlay) {
          overlay.remove();
        }
        scheduleMainBrowserResize();
        return;
      }
      const el = ensureOverlay();
      positionOverlay(el);
      const overlayLabel = $isMainBrowser.get()
        ? t('terminal.sizedForSmallerScreen')
        : `${t('terminal.sizedForSmallerScreen')} - ${t('terminal.makeReferenceScaleBrowser')}`;
      setOverlayCopy(el, overlayLabel);
    } else if (!isMainBrowser) {
      const el = ensureOverlay();
      positionOverlay(el);
      setOverlayCopy(el, t('terminal.makeReferenceScaleBrowser'));
    } else if (overlay) {
      overlay.remove();
      overlay = null;
    }
  } else {
    // Perfect fit — no transform needed
    xterm.style.transform = '';
    xterm.style.transformOrigin = '';
    container.classList.remove('scaled');

    if (!isMainBrowser) {
      const el = ensureOverlay();
      positionOverlay(el);
      setOverlayCopy(el, t('terminal.makeReferenceScaleBrowser'));
    } else if (overlay) {
      overlay.remove();
    }
  }
}

/**
 * Apply CSS scaling to a terminal to fit within its container.
 * Scales down terminals that are larger than the available space.
 */
export function applyTerminalScaling(_sessionId: string, state: TerminalState): void {
  requestAnimationFrame(() => {
    applyTerminalScalingSync(state);
  });
}

/**
 * Recalculate scaling for all open terminals (internal, non-debounced)
 */
function rescaleAllTerminalsInternal(): void {
  sessionTerminals.forEach((state, sessionId) => {
    if (state.opened) {
      applyTerminalScaling(sessionId, state);
    }
  });
}

/**
 * Recalculate scaling for all open terminals (throttled for smooth live updates during resize)
 */
export const rescaleAllTerminals = throttle(rescaleAllTerminalsInternal, 16);

/**
 * Rescale terminals immediately (for sidebar collapse/expand)
 */
export function rescaleAllTerminalsImmediate(): void {
  rescaleAllTerminalsInternal();
}

/**
 * Auto-resize all visible terminals to fit their containers.
 * For layout panes, resizes to pane size. For standalone, resizes to screen.
 */
function autoResizeAllTerminalsInternal(): void {
  sessionTerminals.forEach((state, sessionId) => {
    if (!state.opened) return;

    // Never auto-resize while the user is reading scrollback. Keep the server-side
    // size stable and only refresh CSS scaling for the current container.
    if (isTerminalViewingScrollback(state)) {
      applyTerminalScaling(sessionId, state);
      return;
    }

    const layoutPane = state.container.closest<HTMLElement>('.layout-leaf');
    if (layoutPane) {
      fitTerminalToContainer(sessionId, layoutPane);
    } else if (!state.container.classList.contains('hidden')) {
      fitSessionToScreen(sessionId);
    }
  });
}

let autoResizeTimer: number | undefined;
let mainBrowserContainerResizeObserver: ResizeObserver | null = null;
let observedMainBrowserContainer: HTMLElement | null = null;

/**
 * Auto-resize all terminals (debounced 300ms, for window resize events).
 * Only active when $isMainBrowser is true.
 */
export function autoResizeAllTerminals(): void {
  if (autoResizeTimer !== undefined) {
    clearTimeout(autoResizeTimer);
  }
  autoResizeTimer = window.setTimeout(() => {
    autoResizeTimer = undefined;
    autoResizeAllTerminalsInternal();
  }, 300);
}

/**
 * Auto-resize all terminals immediately (for sidebar/layout changes).
 * Only active when $isMainBrowser is true.
 */
export function autoResizeAllTerminalsImmediate(): void {
  autoResizeAllTerminalsInternal();
}

function ensureMainBrowserContainerResizeObserver(): void {
  if (typeof ResizeObserver === 'undefined') {
    return;
  }

  const container = dom.terminalsArea;
  if (!container) {
    return;
  }

  if (!mainBrowserContainerResizeObserver) {
    mainBrowserContainerResizeObserver = new ResizeObserver(() => {
      if ($isMainBrowser.get()) {
        autoResizeAllTerminalsImmediate();
      }
    });
  }

  if (observedMainBrowserContainer === container) {
    return;
  }

  mainBrowserContainerResizeObserver.disconnect();
  mainBrowserContainerResizeObserver.observe(container);
  observedMainBrowserContainer = container;
}

function disconnectMainBrowserContainerResizeObserver(): void {
  mainBrowserContainerResizeObserver?.disconnect();
  observedMainBrowserContainer = null;
}

let _mainResizeScheduled = false;

function scheduleMainBrowserResize(): void {
  if (_mainResizeScheduled) return;
  _mainResizeScheduled = true;
  requestAnimationFrame(() => {
    _mainResizeScheduled = false;
    if (!$isMainBrowser.get()) return;
    autoResizeAllTerminalsImmediate();
  });
}

let foregroundResizeRecoveryScheduled = false;
let mainBrowserGeometryWatchdogTimer: number | null = null;
let mainBrowserGeometryWatchdogFrame: number | null = null;
let lastMainBrowserGeometrySignature: string | null = null;

/**
 * Recover main-browser sizing after the page returns to the foreground.
 * Uses the lightweight periodic mismatch check so correctly sized terminals
 * remain untouched and do not trigger unnecessary renderer/layout work.
 */
export function scheduleForegroundResizeRecovery(): void {
  if (foregroundResizeRecoveryScheduled) return;
  foregroundResizeRecoveryScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      foregroundResizeRecoveryScheduled = false;
      if (!$isMainBrowser.get()) return;
      ensureMainBrowserContainerResizeObserver();
      periodicResizeCheck();
    });
  });
}

function invalidateMainBrowserGeometryWatchdog(): void {
  lastMainBrowserGeometrySignature = null;
}

function roundGeometry(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }

  return String(Math.round(value));
}

function buildMainBrowserGeometrySignature(): string | null {
  if (!$isMainBrowser.get()) {
    return null;
  }

  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return null;
  }

  const parts: string[] = [];
  const visualViewport = window.visualViewport;
  const terminalsAreaRect = dom.terminalsArea?.getBoundingClientRect() ?? null;
  const activeId = $activeSessionId.get();

  parts.push(`win:${roundGeometry(window.innerWidth)}x${roundGeometry(window.innerHeight)}`);
  parts.push(`dpr:${roundGeometry(window.devicePixelRatio * 1000)}`);
  parts.push(
    `vv:${roundGeometry(visualViewport?.width)}x${roundGeometry(visualViewport?.height)}@${roundGeometry(visualViewport?.offsetLeft)}:${roundGeometry(visualViewport?.offsetTop)}`,
  );
  parts.push(
    `area:${roundGeometry(terminalsAreaRect?.width)}x${roundGeometry(terminalsAreaRect?.height)}`,
  );
  parts.push(`active:${activeId ?? ''}`);

  sessionTerminals.forEach((state, sessionId) => {
    if (!state.opened) {
      return;
    }

    const layoutPane = state.container.closest<HTMLElement>('.layout-leaf');
    if (!layoutPane) {
      if (sessionId !== activeId || state.container.classList.contains('hidden')) {
        return;
      }
    }

    const measurementRoot = layoutPane ?? state.container;
    const rect = measurementRoot.getBoundingClientRect();
    parts.push(
      [
        sessionId,
        layoutPane ? 'layout' : 'standalone',
        roundGeometry(rect.width),
        roundGeometry(rect.height),
        roundGeometry(state.container.clientWidth),
        roundGeometry(state.container.clientHeight),
      ].join(':'),
    );
  });

  return parts.join('|');
}

function queueMainBrowserGeometryWatchdog(): void {
  if (mainBrowserGeometryWatchdogTimer !== null || mainBrowserGeometryWatchdogFrame !== null) {
    return;
  }

  mainBrowserGeometryWatchdogTimer = window.setTimeout(() => {
    mainBrowserGeometryWatchdogTimer = null;
    mainBrowserGeometryWatchdogFrame = window.requestAnimationFrame(() => {
      mainBrowserGeometryWatchdogFrame = null;
      runMainBrowserGeometryWatchdog();
    });
  }, 0);
}

function runMainBrowserGeometryWatchdog(): void {
  if (!$isMainBrowser.get()) {
    stopMainBrowserGeometryWatchdog();
    return;
  }

  const signature = buildMainBrowserGeometrySignature();
  if (signature === null) {
    invalidateMainBrowserGeometryWatchdog();
    queueMainBrowserGeometryWatchdog();
    return;
  }

  if (signature !== lastMainBrowserGeometrySignature) {
    lastMainBrowserGeometrySignature = signature;
    scheduleForegroundResizeRecovery();
  }

  queueMainBrowserGeometryWatchdog();
}

function ensureMainBrowserGeometryWatchdog(): void {
  if (mainBrowserGeometryWatchdogTimer !== null || mainBrowserGeometryWatchdogFrame !== null) {
    return;
  }

  invalidateMainBrowserGeometryWatchdog();
  queueMainBrowserGeometryWatchdog();
}

function stopMainBrowserGeometryWatchdog(): void {
  if (mainBrowserGeometryWatchdogTimer !== null) {
    window.clearTimeout(mainBrowserGeometryWatchdogTimer);
    mainBrowserGeometryWatchdogTimer = null;
  }

  if (mainBrowserGeometryWatchdogFrame !== null) {
    window.cancelAnimationFrame(mainBrowserGeometryWatchdogFrame);
    mainBrowserGeometryWatchdogFrame = null;
  }

  invalidateMainBrowserGeometryWatchdog();
}

/**
 * Central dock layout change handler.
 * All dock modules call this after opening/closing/resizing a dock panel.
 * Uses rAF coalescing so close+open in the same synchronous block (e.g., dock
 * state restore on session switch) produces only a single resize pass.
 */
let dockChangeScheduled = false;

export function handleDockLayoutChange(): void {
  if (dockChangeScheduled) return;
  dockChangeScheduled = true;
  requestAnimationFrame(() => {
    dockChangeScheduled = false;
    if ($isMainBrowser.get()) {
      autoResizeAllTerminalsImmediate();
    } else {
      rescaleAllTerminalsImmediate();
    }
  });
}

/** Last periodic resize check result for diagnostics overlay */
let lastPeriodicCheckResult = 'idle';

export function getLastPeriodicCheckResult(): string {
  return lastPeriodicCheckResult;
}

/**
 * Periodic check: compare current terminal dimensions against what they should be.
 * Only resizes when a real mismatch is found. Does NOT touch focus, transforms,
 * overlays, or any other DOM state — just terminal.resize() + sendResize().
 */
function periodicResizeCheck(): void {
  const sessions = $sessions.get();
  const details: string[] = [];

  const activeId = $activeSessionId.get();

  sessionTerminals.forEach((state, sessionId) => {
    if (!state.opened) return;

    if (isTerminalViewingScrollback(state)) {
      applyTerminalScaling(sessionId, state);
      return;
    }

    const layoutPane = state.container.closest<HTMLElement>('.layout-leaf');

    // Skip standalone sessions that aren't active — dock layout in DOM
    // reflects the active session's config, not theirs.
    if (!layoutPane && sessionId !== activeId) return;

    const container = layoutPane ?? dom.terminalsArea;
    if (!container) return;

    const termCols = state.terminal.cols;
    const termRows = state.terminal.rows;
    if (termCols <= 0 || termRows <= 0) return;

    refreshRendererForMeasurement(state);

    const optimal = calculateOptimalDimensionsForViewport(state, container, !!layoutPane);
    if (!optimal) return;
    const optimalCols = optimal.cols;
    const optimalRows = optimal.rows;

    if (termCols !== optimalCols || termRows !== optimalRows) {
      const session = sessions[sessionId];
      const name = session?.name ?? sessionId.substring(0, 8);
      details.push(`${name}: ${termCols}×${termRows} → ${optimalCols}×${optimalRows}`);
      try {
        state.terminal.resize(optimalCols, optimalRows);
        state.serverCols = optimalCols;
        state.serverRows = optimalRows;
        sendResize(sessionId, optimalCols, optimalRows);
      } catch {
        // terminal may be disposed
      }
      requestAnimationFrame(() => {
        applyTerminalScalingSync(state);
      });
    }
  });

  lastPeriodicCheckResult = details.length > 0 ? details.join('; ') : 'no change';
}

/**
 * Set up resize observer to recalculate scaling when window resizes.
 * Main browser: auto-resize terminals. Follower: CSS scale only.
 * Also starts a 1-second periodic check for the main browser to catch
 * resize scenarios that don't fire standard events.
 */
export function setupResizeObserver(): void {
  window.addEventListener('resize', () => {
    if ($isMainBrowser.get()) {
      autoResizeAllTerminals();
    } else {
      rescaleAllTerminals();
    }
  });

  const handleForegroundRecovery = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    invalidateMainBrowserGeometryWatchdog();
    scheduleForegroundResizeRecovery();
  };

  document.addEventListener('visibilitychange', () => {
    invalidateMainBrowserGeometryWatchdog();
    if (document.visibilityState === 'visible') {
      handleForegroundRecovery();
    }
  });
  window.addEventListener('focus', handleForegroundRecovery);
  window.addEventListener('pageshow', handleForegroundRecovery);
  window.addEventListener('pagehide', invalidateMainBrowserGeometryWatchdog);
  window.addEventListener('blur', invalidateMainBrowserGeometryWatchdog);

  let periodicResizeInterval: number | undefined;

  $isMainBrowser.subscribe((isMain) => {
    if (isMain && periodicResizeInterval === undefined) {
      requestAnimationFrame(() => {
        ensureMainBrowserContainerResizeObserver();
        ensureMainBrowserGeometryWatchdog();
        autoResizeAllTerminalsImmediate();
      });
      periodicResizeInterval = window.setInterval(periodicResizeCheck, 1000);
    } else if (!isMain && periodicResizeInterval !== undefined) {
      clearInterval(periodicResizeInterval);
      periodicResizeInterval = undefined;
      disconnectMainBrowserContainerResizeObserver();
      stopMainBrowserGeometryWatchdog();
      requestAnimationFrame(rescaleAllTerminalsImmediate);
    }
  });
}

/**
 * Set up visual viewport handling for mobile keyboard appearance.
 * Constrains the .terminal-page height to the visual viewport so the entire
 * flex layout (topbar, terminals, touch controller) fits above the keyboard.
 * Also toggles a 'keyboard-visible' class on body to hide UI chrome.
 */
export function setupVisualViewport(): void {
  if (!window.visualViewport) return;

  const vv = window.visualViewport;
  let lastHeight = 0;
  let baselineHeight = Math.max(window.innerHeight, vv.height);
  const KEYBOARD_RATIO_THRESHOLD = 0.88;
  const KEYBOARD_PIXEL_THRESHOLD = 120;
  const appEl = document.querySelector<HTMLElement>('.terminal-page');

  const update = () => {
    const vh = vv.height;
    if (vh > baselineHeight) {
      baselineHeight = vh;
    }
    if (Math.abs(vh - lastHeight) < 1) return;
    lastHeight = vh;

    if (appEl) {
      appEl.style.height = `${vh}px`;
    }

    // Lock root/body to visual viewport height to prevent dragging hidden
    // off-screen space (common when soft keyboard is open in mobile PWAs).
    document.documentElement.style.height = `${vh}px`;
    document.documentElement.style.maxHeight = `${vh}px`;
    document.body.style.height = `${vh}px`;
    document.body.style.maxHeight = `${vh}px`;

    if (vv.offsetTop !== 0) {
      window.scrollTo(0, 0);
    }

    const heightDrop = baselineHeight - vh;
    const kbVisible =
      vh < baselineHeight * KEYBOARD_RATIO_THRESHOLD && heightDrop >= KEYBOARD_PIXEL_THRESHOLD;
    if (kbVisible !== document.body.classList.contains('keyboard-visible')) {
      document.body.classList.toggle('keyboard-visible', kbVisible);
    }

    if ($isMainBrowser.get()) {
      autoResizeAllTerminalsImmediate();
    } else {
      rescaleAllTerminals();
    }
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
