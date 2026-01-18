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
  TERMINAL_FONT_STACK,
  icon,
} from '../../constants';
import { sessionTerminals, fontsReadyPromise, dom, currentSettings } from '../../state';
import { $activeSessionId, getSession } from '../../stores';
import { throttle } from '../../utils';

// Forward declarations for functions from other modules
let sendResize: (sessionId: string, dimensions: { cols: number; rows: number }) => void = () => {};
let focusActiveTerminal: () => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerScalingCallbacks(callbacks: {
  sendResize?: (sessionId: string, dimensions: { cols: number; rows: number }) => void;
  focusActiveTerminal?: () => void;
}): void {
  if (callbacks.sendResize) sendResize = callbacks.sendResize;
  if (callbacks.focusActiveTerminal) focusActiveTerminal = callbacks.focusActiveTerminal;
}

type MeasurementSource = 'existing-terminal' | 'font-probe';

function logResizeDiagnostics(
  operation: 'create' | 'manual-resize',
  sessionId: string,
  container: HTMLElement,
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
    const xterm = state.container.querySelector('.xterm') as HTMLElement | null;
    const screen = state.container.querySelector('.xterm-screen') as HTMLElement | null;
    if (xterm && screen) {
      actualWidth = screen.offsetWidth;
      actualHeight = screen.offsetHeight;
      const availW = state.container.clientWidth - 8;
      const availH = state.container.clientHeight - 8;
      const scaleX = availW / xterm.offsetWidth;
      const scaleY = availH / xterm.offsetHeight;
      scaleFactor = Math.min(scaleX, scaleY, 1);
    }
  }

  console.log(
    `[RESIZE DIAG] ${operation}\n` +
      `  Session: "${session?.name ?? sessionId}" (${session?.terminalTitle ?? 'no title'})\n` +
      `  Container: ${containerRect.width.toFixed(0)}×${containerRect.height.toFixed(0)} px\n` +
      `  Font: ${TERMINAL_FONT_STACK.split(',')[0]}, ${fontSize}px\n` +
      `  Cell size: ${cellWidth.toFixed(2)}×${cellHeight.toFixed(2)} px (from: ${measurementSource})\n` +
      `  Calculated fit: ${cols}×${rows}\n` +
      `  Assumed size: ${assumedWidth.toFixed(0)}×${assumedHeight.toFixed(0)} px\n` +
      `  Actual size: ${actualWidth.toFixed(0)}×${actualHeight.toFixed(0)} px\n` +
      `  Scale factor: ${scaleFactor.toFixed(3)}`,
  );
}

/**
 * Measure actual cell dimensions from an existing terminal.
 * Returns null if no terminal is available or measurements are invalid.
 */
function measureFromExistingTerminal(): { cellWidth: number; cellHeight: number } | null {
  for (const state of sessionTerminals.values()) {
    if (!state.opened) continue;

    const screen = state.container.querySelector('.xterm-screen') as HTMLElement | null;
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
function measureFromFont(fontSize: number): { cellWidth: number; cellHeight: number } {
  const measureEl = document.createElement('span');
  measureEl.style.cssText = `
    position: absolute;
    visibility: hidden;
    font-family: ${TERMINAL_FONT_STACK};
    font-size: ${fontSize}px;
    line-height: 1;
    white-space: pre;
  `;
  measureEl.textContent = 'W';
  document.body.appendChild(measureEl);

  const cellWidth = measureEl.offsetWidth;
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
  sessionIdForLog?: string,
): Promise<{ cols: number; rows: number } | null> {
  const rect = container.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) {
    return null;
  }

  // Get cell dimensions: prefer existing terminal, otherwise measure font directly
  const existingMeasurement = measureFromExistingTerminal();
  const measurementSource: MeasurementSource = existingMeasurement
    ? 'existing-terminal'
    : 'font-probe';

  // When using font-probe, wait for fonts to be loaded first
  if (!existingMeasurement && fontsReadyPromise) {
    await fontsReadyPromise;
  }

  const { cellWidth, cellHeight } = existingMeasurement ?? measureFromFont(fontSize);

  // Account for padding and scrollbar width
  const availWidth = rect.width - TERMINAL_PADDING - SCROLLBAR_WIDTH;
  const availHeight = rect.height - TERMINAL_PADDING;

  const cols = Math.floor(availWidth / cellWidth);
  const rows = Math.floor(availHeight / cellHeight);

  // Clamp to valid range
  const clampedCols = Math.max(MIN_TERMINAL_COLS, Math.min(cols, MAX_TERMINAL_COLS));
  const clampedRows = Math.max(MIN_TERMINAL_ROWS, Math.min(rows, MAX_TERMINAL_ROWS));

  if (clampedCols <= MIN_TERMINAL_COLS || clampedRows <= MIN_TERMINAL_ROWS) {
    return null;
  }

  if (sessionIdForLog) {
    logResizeDiagnostics(
      'create',
      sessionIdForLog,
      container,
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

/**
 * Fit a session's terminal to the current screen size.
 * This sends a resize request to the server.
 *
 * Uses direct measurement of terminalsArea via getBoundingClientRect() rather than
 * FitAddon's measurement of the terminal container. This avoids timing issues where
 * clearing zoom/scale causes layout to be in flux when measurements occur.
 */
export function fitSessionToScreen(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Capture fontSize for diagnostics
  const fontSize = currentSettings?.fontSize ?? 14;

  // Wait for terminal to be opened before fitting
  if (!state.opened) {
    (fontsReadyPromise ?? Promise.resolve()).then(() => {
      fitSessionToScreen(sessionId);
    });
    return;
  }

  // Clear any existing scaling first
  const xterm = state.container.querySelector('.xterm') as HTMLElement | null;
  if (xterm) {
    xterm.style.transform = '';
    state.container.classList.remove('scaled');
  }

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

  // Get cell dimensions by measuring the terminal's rendered size
  const screen = state.container.querySelector('.xterm-screen') as HTMLElement | null;
  const terminalCols = state.terminal.cols;
  const terminalRows = state.terminal.rows;

  let cellWidth: number | null = null;
  let cellHeight: number | null = null;

  if (screen && terminalCols > 0 && terminalRows > 0) {
    cellWidth = screen.offsetWidth / terminalCols;
    cellHeight = screen.offsetHeight / terminalRows;
  }

  if (!cellWidth || !cellHeight || cellWidth < 1 || cellHeight < 1) {
    // Fallback to FitAddon if measurements aren't valid
    requestAnimationFrame(() => {
      try {
        const dims = state.fitAddon.proposeDimensions();
        if (dims?.cols && dims?.rows) {
          state.fitAddon.fit();
          sendResize(sessionId, state.terminal);
        }
      } catch {
        // FitAddon may fail if terminal isn't fully initialized
      }

      if (wasHidden) {
        state.container.classList.add('hidden');
      }
      focusActiveTerminal();
    });
    return;
  }

  // Calculate available space (accounting for container padding and scrollbar)
  const rect = dom.terminalsArea.getBoundingClientRect();
  const availWidth = rect.width - TERMINAL_PADDING - SCROLLBAR_WIDTH;
  const availHeight = rect.height - TERMINAL_PADDING;

  // Calculate cols/rows that fit in available space
  let cols = Math.floor(availWidth / cellWidth);
  let rows = Math.floor(availHeight / cellHeight);

  // Clamp to valid range
  cols = Math.max(MIN_TERMINAL_COLS, Math.min(cols, MAX_TERMINAL_COLS));
  rows = Math.max(MIN_TERMINAL_ROWS, Math.min(rows, MAX_TERMINAL_ROWS));

  // Resize terminal and notify server
  requestAnimationFrame(() => {
    try {
      if (state.terminal.cols !== cols || state.terminal.rows !== rows) {
        state.terminal.resize(cols, rows);
        sendResize(sessionId, state.terminal);
      }
    } catch {
      // Resize may fail if terminal is disposed
    }

    // Re-apply scaling check (fixes badge persistence bug)
    applyTerminalScalingSync(state);

    logResizeDiagnostics(
      'manual-resize',
      sessionId,
      dom.terminalsArea!,
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
  });
}

/**
 * Apply CSS scaling to a terminal synchronously.
 * Use this when already inside a requestAnimationFrame callback.
 */
export function applyTerminalScalingSync(state: TerminalState): void {
  const container = state.container;
  const xterm = container.querySelector('.xterm') as HTMLElement | null;
  if (!xterm) return;

  const availWidth = container.clientWidth - 8;
  const availHeight = container.clientHeight - 8;
  const termWidth = xterm.offsetWidth;
  const termHeight = xterm.offsetHeight;

  // Calculate scale (shrink only, never enlarge)
  const scaleX = availWidth / termWidth;
  const scaleY = availHeight / termHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  // Find or create overlay element
  let overlay = container.querySelector('.scaled-overlay') as HTMLElement | null;

  // Use 0.97 threshold to account for rounding errors between fit calculation and actual render
  if (scale < 0.97) {
    // Use transform: scale() with explicit transform-origin for predictable behavior
    xterm.style.transform = `scale(${scale})`;
    xterm.style.transformOrigin = 'top left';
    container.classList.add('scaled');

    // Add clickable overlay if not present
    if (!overlay) {
      overlay = document.createElement('button');
      overlay.className = 'scaled-overlay';
      overlay.innerHTML = `${icon('resize')} Scaled view - click to resize`;
      overlay.addEventListener('click', () => {
        const activeId = $activeSessionId.get();
        if (activeId) {
          fitSessionToScreen(activeId);
        }
      });
      container.appendChild(overlay);
    }
  } else {
    xterm.style.transform = '';
    xterm.style.transformOrigin = '';
    container.classList.remove('scaled');

    // Remove overlay if present
    if (overlay) {
      overlay.remove();
    }
  }
}

/**
 * Apply CSS scaling to a terminal to fit within its container.
 * Scales down terminals that are larger than the available space.
 */
export function applyTerminalScaling(_sessionId: string, state: TerminalState): void {
  requestAnimationFrame(() => applyTerminalScalingSync(state));
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
 * Set up resize observer to recalculate scaling when window resizes
 */
export function setupResizeObserver(): void {
  window.addEventListener('resize', rescaleAllTerminals);
}

/**
 * Set up visual viewport handling for mobile keyboard appearance.
 * Updates viewport height CSS variable when visual viewport changes.
 */
export function setupVisualViewport(): void {
  if (!window.visualViewport || !dom.terminalsArea) return;

  const visualViewport = window.visualViewport;
  const terminalsArea = dom.terminalsArea;
  let lastHeight = 0;

  const updateViewportHeight = () => {
    const vh = visualViewport.height;
    if (Math.abs(vh - lastHeight) < 1) return;
    lastHeight = vh;

    document.documentElement.style.setProperty('--visual-vh', vh + 'px');

    const mobileHeader = document.querySelector('.mobile-header') as HTMLElement | null;
    let headerHeight = 0;
    if (mobileHeader && window.getComputedStyle(mobileHeader).display !== 'none') {
      headerHeight = mobileHeader.offsetHeight;
    }

    const availableHeight = Math.floor((vh - headerHeight) * 0.99);
    terminalsArea.style.height = availableHeight + 'px';

    // Rescale terminals after viewport height change
    rescaleAllTerminals();
  };

  visualViewport.addEventListener('resize', updateViewportHeight);
  updateViewportHeight();
}
