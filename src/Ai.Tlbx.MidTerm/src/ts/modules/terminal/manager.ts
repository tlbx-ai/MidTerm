/**
 * Terminal Manager Module
 *
 * Handles xterm.js terminal lifecycle, creation, destruction,
 * and event binding for terminal sessions.
 */

import type { Session, TerminalState } from '../../types';
import {
  THEMES,
  MOBILE_BREAKPOINT,
  TERMINAL_FONT_STACK,
  ACTIVE_SCROLLBACK,
  BACKGROUND_SCROLLBACK,
} from '../../constants';
import {
  sessionTerminals,
  pendingOutputFrames,
  sessionsNeedingResync,
  fontsReadyPromise,
  dom,
  setFontsReadyPromise,
  MAX_WEBGL_CONTEXTS,
  terminalsWithWebgl,
} from '../../state';
import { $activeSessionId, $currentSettings, $windowsBuildNumber } from '../../stores';
import { getClipboardStyle, parseOutputFrame } from '../../utils';
import { applyTerminalScaling, applyTerminalScalingSync } from './scaling';
import { setupFileDrop, handleClipboardPaste, sanitizePasteContent } from './fileDrop';
import { isBracketedPasteEnabled, sendCommand } from '../comms';
import { showPasteIndicator, hidePasteIndicator } from '../badges';

import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import {
  initSearchForTerminal,
  showSearch,
  isSearchVisible,
  hideSearch,
  cleanupSearchForTerminal,
} from './search';

import { registerFileLinkProvider, scanOutputForPaths, clearPathAllowlist } from './fileLinks';

// Forward declarations for functions from other modules
let sendInput: (sessionId: string, data: string) => void = () => {};
let showBellNotification: (sessionId: string) => void = () => {};
let requestBufferRefresh: (sessionId: string) => void = () => {};

// Debounce timers for auto-rename from shell title
const pendingTitleUpdates = new Map<string, number>();

// Calibration measurement from hidden terminal (accurate cell dimensions)
let calibrationMeasurement: { cellWidth: number; cellHeight: number } | null = null;
let calibrationPromise: Promise<void> | null = null;

// Debounce timer for focus operations
let focusDebounceTimer: number | null = null;

/**
 * Focus the active terminal, debounced to prevent rapid focus/blur cycles.
 * Respects search panel - won't focus if search is visible.
 */
export function focusActiveTerminal(): void {
  if (isSearchVisible()) return;

  if (focusDebounceTimer !== null) {
    window.clearTimeout(focusDebounceTimer);
  }

  focusDebounceTimer = window.setTimeout(() => {
    focusDebounceTimer = null;
    const activeId = $activeSessionId.get();
    if (!activeId) return;

    const state = sessionTerminals.get(activeId);
    if (state?.opened) {
      state.terminal.focus();
    }
  }, 16); // Single frame (60fps) prevents focus/blur thrashing
}

/**
 * Auto-update session terminalTitle from shell title (with debounce).
 * Always sends to server to update terminalTitle field.
 * Server will only update 'name' if session is not manually named.
 */
function updateSessionNameAuto(sessionId: string, name: string): void {
  const existing = pendingTitleUpdates.get(sessionId);
  if (existing) {
    window.clearTimeout(existing);
  }

  const timer = window.setTimeout(() => {
    pendingTitleUpdates.delete(sessionId);
    sendCommand('session.rename', { sessionId, name, auto: true }).catch(() => {});
  }, 500);

  pendingTitleUpdates.set(sessionId, timer);
}

/**
 * Register callbacks from other modules
 */
export function registerTerminalCallbacks(callbacks: {
  sendInput?: (sessionId: string, data: string) => void;
  showBellNotification?: (sessionId: string) => void;
  requestBufferRefresh?: (sessionId: string) => void;
}): void {
  if (callbacks.sendInput) sendInput = callbacks.sendInput;
  if (callbacks.showBellNotification) showBellNotification = callbacks.showBellNotification;
  if (callbacks.requestBufferRefresh) requestBufferRefresh = callbacks.requestBufferRefresh;
}

/**
 * Get terminal options based on current settings
 */
export function getTerminalOptions(): ITerminalOptions {
  const currentSettings = $currentSettings.get();
  const windowsBuildNumber = $windowsBuildNumber.get();
  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  const baseFontSize = currentSettings?.fontSize ?? 14;
  const fontSize = isMobile ? Math.max(baseFontSize - 2, 10) : baseFontSize;
  const themeName = currentSettings?.theme ?? 'dark';
  const fontFamily = currentSettings?.fontFamily ?? 'Cascadia Code';

  const options: ITerminalOptions = {
    cursorBlink: currentSettings?.cursorBlink ?? true,
    cursorStyle: currentSettings?.cursorStyle ?? 'bar',
    cursorInactiveStyle: currentSettings?.cursorInactiveStyle ?? 'outline',
    fontFamily: `'${fontFamily}', ${TERMINAL_FONT_STACK}`,
    fontSize: fontSize,
    letterSpacing: 0,
    lineHeight: 1,
    scrollback: currentSettings?.scrollbackLines ?? 10000,
    minimumContrastRatio: currentSettings?.minimumContrastRatio ?? 1,
    smoothScrollDuration: currentSettings?.smoothScrolling ? 50 : 0,
    allowProposedApi: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    theme: THEMES[themeName] ?? THEMES.dark,
  };

  // Configure ConPTY for Windows - use server-provided build or detect from userAgent
  const isWindows = /Windows|Win32|Win64/i.test(navigator.userAgent);
  if (windowsBuildNumber !== null) {
    options.windowsPty = {
      backend: 'conpty',
      buildNumber: windowsBuildNumber,
    };
  } else if (isWindows) {
    // Default to Windows 10 2004 (19041) which has stable ConPTY support
    // This ensures proper VT sequence interpretation before health check completes
    options.windowsPty = {
      backend: 'conpty',
      buildNumber: 19041,
    };
  }

  return options;
}

/**
 * Create a terminal instance for a session.
 * Returns existing state if terminal already exists.
 */
export function createTerminalForSession(
  sessionId: string,
  sessionInfo: Session | undefined,
): TerminalState {
  const existing = sessionTerminals.get(sessionId);
  if (existing) {
    return existing;
  }

  // Create container
  const container = document.createElement('div');
  container.className = 'terminal-container hidden';
  container.id = 'terminal-' + sessionId;
  dom.terminalsArea?.appendChild(container);

  // Set up file drop handler for drag-and-drop uploads
  setupFileDrop(container);

  // Initialize xterm.js
  const terminal = new Terminal(getTerminalOptions());
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Load Unicode11 addon for proper emoji and CJK character width handling
  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = '11';

  // Get server dimensions from session info (if available)
  const serverCols = sessionInfo && sessionInfo.cols > 0 ? sessionInfo.cols : 0;
  const serverRows = sessionInfo && sessionInfo.rows > 0 ? sessionInfo.rows : 0;

  const state: TerminalState = {
    terminal: terminal,
    fitAddon: fitAddon,
    container: container,
    serverCols: serverCols,
    serverRows: serverRows,
    opened: false,
  };

  sessionTerminals.set(sessionId, state);

  // Wait for fonts to be ready before opening terminal
  // This ensures xterm.js measures the correct font for canvas rendering
  (fontsReadyPromise ?? Promise.resolve()).then(() => {
    if (!sessionTerminals.has(sessionId)) return; // Session was deleted

    try {
      terminal.open(container);
    } catch (e) {
      console.error(`Terminal ${sessionId} failed to open:`, e);
      container.innerHTML =
        '<div class="terminal-error">Terminal failed to initialize. <button onclick="location.reload()">Reload</button></div>';
      container.classList.remove('hidden');
      return;
    }

    state.opened = true;

    // Register onData immediately to avoid losing keystrokes during font/rAF delay
    // Other event handlers are set up later in setupTerminalEvents
    state.earlyDataDisposable = terminal.onData((data: string) => {
      sendInput(sessionId, data);
    });

    // Load WebGL addon for GPU-accelerated rendering (with context limit)
    // Browser limits ~6-8 simultaneous WebGL contexts, so we track usage
    if (
      $currentSettings.get()?.useWebGL !== false &&
      terminalsWithWebgl.size < MAX_WEBGL_CONTEXTS
    ) {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          terminalsWithWebgl.delete(sessionId);
          state.hasWebgl = false;
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
        terminalsWithWebgl.add(sessionId);
        state.hasWebgl = true;
      } catch {
        // WebGL not available, using canvas renderer
      }
    }

    // Load Web-Links addon for clickable URLs
    try {
      const webLinksAddon = new WebLinksAddon((_event: MouseEvent, uri: string) => {
        if (uri.startsWith('http://') || uri.startsWith('https://')) {
          window.open(uri, '_blank', 'noopener,noreferrer');
        }
      });
      terminal.loadAddon(webLinksAddon);
    } catch {
      // Web-Links addon failed to load
    }

    // Register file link provider for clickable file paths
    registerFileLinkProvider(terminal, sessionId);

    // Load Search addon for Ctrl+F search
    initSearchForTerminal(sessionId, terminal);

    // Replay any WebSocket frames that arrived before terminal was opened
    replayPendingFrames(sessionId, state);

    // Defer resize to next frame - xterm.js needs a frame to fully initialize after open()
    requestAnimationFrame(() => {
      if (!sessionTerminals.has(sessionId)) return; // Session was deleted

      // Sync xterm to server dimensions (local only, no server notification)
      // This ensures the terminal matches what the server has without triggering resize race conditions
      if (state.serverCols > 0 && state.serverRows > 0) {
        try {
          state.terminal.resize(state.serverCols, state.serverRows);
        } catch {
          // Resize may fail if terminal not fully initialized
        }
      }
      applyTerminalScalingSync(state); // Sync version - already in rAF context

      setupTerminalEvents(sessionId, terminal, container);
    });
  });

  return state;
}

/**
 * Replay pending output frames that arrived before terminal was opened.
 * If frames overflowed, request a full buffer refresh instead.
 */
function replayPendingFrames(sessionId: string, state: TerminalState): void {
  // Check if this session overflowed and needs a full resync
  if (sessionsNeedingResync.has(sessionId)) {
    sessionsNeedingResync.delete(sessionId);
    pendingOutputFrames.delete(sessionId);
    requestBufferRefresh(sessionId);
    return;
  }

  const frames = pendingOutputFrames.get(sessionId);
  if (frames && frames.length > 0) {
    frames.forEach((payload) => {
      writeOutputFrame(sessionId, state, payload);
    });
    pendingOutputFrames.delete(sessionId);
  }
}

/**
 * Write an output frame to the terminal, handling dimension updates
 */
export function writeOutputFrame(
  sessionId: string,
  state: TerminalState,
  payload: Uint8Array,
): void {
  const frame = parseOutputFrame(payload);

  // Ensure terminal matches frame dimensions before writing
  if (frame.valid && state.opened) {
    const currentCols = state.terminal.cols;
    const currentRows = state.terminal.rows;

    if (currentCols !== frame.cols || currentRows !== frame.rows) {
      try {
        state.terminal.resize(frame.cols, frame.rows);
        state.serverCols = frame.cols;
        state.serverRows = frame.rows;
        applyTerminalScaling(sessionId, state);
      } catch {
        // Ignore resize errors - terminal may not be fully initialized
      }
    }
  }

  // Write terminal data
  if (frame.data.length > 0) {
    state.terminal.write(frame.data);

    // Scan output for file paths to make them clickable
    // See fileLinks.ts for performance notes - can be disabled if needed
    scanOutputForPaths(sessionId, frame.data);
  }
}

/**
 * Set up terminal event handlers for input, bell, selection, etc.
 */
export function setupTerminalEvents(
  sessionId: string,
  terminal: Terminal,
  container: HTMLDivElement,
): void {
  // Collect disposables for cleanup
  const disposables: Array<{ dispose: () => void }> = [];

  // Dispose early data handler (was registered immediately after terminal.open)
  const termState = sessionTerminals.get(sessionId);
  if (termState?.earlyDataDisposable) {
    termState.earlyDataDisposable.dispose();
    delete termState.earlyDataDisposable;
  }

  // Wire up events - onData replaces the early handler
  disposables.push(
    terminal.onData((data: string) => {
      sendInput(sessionId, data);
    }),
  );

  disposables.push(
    terminal.onBell(() => {
      showBellNotification(sessionId);
    }),
  );

  disposables.push(
    terminal.onSelectionChange(() => {
      if ($currentSettings.get()?.copyOnSelect && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      }
    }),
  );

  // Auto-update session name from shell title
  disposables.push(
    terminal.onTitleChange((title: string) => {
      if (title && title.trim()) {
        updateSessionNameAuto(sessionId, title.trim());
      }
    }),
  );

  // Keyboard shortcuts for copy/paste
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    // Ctrl+Enter: Send LF (\n) instead of CR (\r) for TUI apps that use it for line breaks
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'Enter') {
      sendInput(sessionId, '\n');
      return false;
    }

    const style = getClipboardStyle($currentSettings.get()?.clipboardShortcuts ?? 'auto');

    if (style === 'windows') {
      // Ctrl+C: copy if selected, else let terminal handle (SIGINT)
      if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
        if (terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
          terminal.clearSelection();
          return false;
        }
        return true;
      }
      // Ctrl+V: paste (images uploaded, text pasted)
      if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
        if (window.isSecureContext) {
          handleClipboardPaste(sessionId);
          return false;
        }
        // Non-secure context: let browser fire paste event, handled by pasteHandler below
        return true;
      }
    } else {
      // Unix: Ctrl+Shift+C to copy
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        if (terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
          terminal.clearSelection();
        }
        return false;
      }
      // Unix: Ctrl+Shift+V to paste (images uploaded, text pasted)
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        if (window.isSecureContext) {
          handleClipboardPaste(sessionId);
          return false;
        }
        // Non-secure context: let browser fire paste event, handled by pasteHandler below
        return true;
      }
    }

    // Ctrl+F / Cmd+F: Open search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      showSearch();
      return false;
    }

    // Escape: Close search if open
    if (e.key === 'Escape' && isSearchVisible()) {
      hideSearch();
      return false;
    }

    return true;
  });

  // Handle paste events - use native clipboardData on non-secure contexts (HTTP)
  // On secure contexts (HTTPS/localhost), handleClipboardPaste uses async Clipboard API
  // Use capture phase to intercept before xterm.js
  const pasteHandler = (e: ClipboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // On non-secure contexts, the async Clipboard API doesn't work
    // Use native clipboardData from the paste event instead
    if (!window.isSecureContext && e.clipboardData) {
      const text = e.clipboardData.getData('text/plain');
      if (text) {
        pasteToTerminal(sessionId, sanitizePasteContent(text));
      }
    }
    // On secure contexts, paste is handled by keyboard shortcut via handleClipboardPaste
  };
  container.addEventListener('paste', pasteHandler, true);

  // Right-click paste (images uploaded, text pasted)
  const contextMenuHandler = (e: MouseEvent) => {
    const settings = $currentSettings.get();
    if (!settings || settings.rightClickPaste !== false) {
      e.preventDefault();
      handleClipboardPaste(sessionId);
    }
  };

  container.addEventListener('contextmenu', contextMenuHandler);

  // Defensive refocus when terminal loses focus unexpectedly
  const xtermElement = terminal.element;
  if (xtermElement) {
    xtermElement.addEventListener('blur', () => {
      setTimeout(() => {
        if (!isSearchVisible() && $activeSessionId.get() === sessionId) {
          focusActiveTerminal();
        }
      }, 100);
    });
  }

  // Auto-hide mouse cursor after 2 seconds of inactivity
  let cursorHideTimer: number | null = null;
  const CURSOR_HIDE_DELAY = 2000;

  const mouseMoveHandler = () => {
    container.classList.remove('cursor-hidden');
    if (cursorHideTimer !== null) {
      window.clearTimeout(cursorHideTimer);
    }
    cursorHideTimer = window.setTimeout(() => {
      container.classList.add('cursor-hidden');
    }, CURSOR_HIDE_DELAY);
  };

  const mouseLeaveHandler = () => {
    container.classList.remove('cursor-hidden');
    if (cursorHideTimer !== null) {
      window.clearTimeout(cursorHideTimer);
      cursorHideTimer = null;
    }
  };

  container.addEventListener('mousemove', mouseMoveHandler);
  container.addEventListener('mouseleave', mouseLeaveHandler);

  // Store handler references for cleanup
  const state = sessionTerminals.get(sessionId);
  if (state) {
    state.contextMenuHandler = contextMenuHandler;
    state.pasteHandler = pasteHandler;
    state.disposables = disposables;
    state.mouseMoveHandler = mouseMoveHandler;
    state.mouseLeaveHandler = mouseLeaveHandler;
  }
}

/**
 * Destroy a terminal for a session and clean up resources
 */
export function destroyTerminalForSession(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Clean up xterm event disposables
  if (state.disposables) {
    state.disposables.forEach((d) => d.dispose());
  }

  // Clean up early data handler if terminal was destroyed before setupTerminalEvents ran
  if (state.earlyDataDisposable) {
    state.earlyDataDisposable.dispose();
  }

  // Clean up DOM event listeners
  if (state.contextMenuHandler) {
    state.container.removeEventListener('contextmenu', state.contextMenuHandler);
  }
  if (state.pasteHandler) {
    state.container.removeEventListener('paste', state.pasteHandler, true);
  }
  if (state.mouseMoveHandler) {
    state.container.removeEventListener('mousemove', state.mouseMoveHandler);
  }
  if (state.mouseLeaveHandler) {
    state.container.removeEventListener('mouseleave', state.mouseLeaveHandler);
  }

  // Clean up search addon state
  cleanupSearchForTerminal(sessionId);

  // Clean up pending title update timer
  const titleTimer = pendingTitleUpdates.get(sessionId);
  if (titleTimer) {
    clearTimeout(titleTimer);
    pendingTitleUpdates.delete(sessionId);
  }

  // Clean up WebGL context tracking
  if (state.hasWebgl) {
    terminalsWithWebgl.delete(sessionId);
  }

  // Clean up file path allowlist
  clearPathAllowlist(sessionId);

  state.terminal.dispose();
  state.container.remove();
  sessionTerminals.delete(sessionId);
  pendingOutputFrames.delete(sessionId);
  sessionsNeedingResync.delete(sessionId);
}

/**
 * Adjust terminal scrollback based on active/background state.
 * Active terminals get full scrollback, background terminals get reduced
 * scrollback to save memory when many terminals are open.
 */
export function setTerminalScrollback(sessionId: string, isActive: boolean): void {
  const state = sessionTerminals.get(sessionId);
  if (!state?.terminal) return;

  const scrollback = isActive
    ? ($currentSettings.get()?.scrollbackLines ?? ACTIVE_SCROLLBACK)
    : BACKGROUND_SCROLLBACK;

  state.terminal.options.scrollback = scrollback;
}

// WebSocket frame limit - backend MuxProtocol.MaxFrameSize is 64KB, use 32KB for safety margin
const WS_MAX_PAYLOAD = 32 * 1024;
// Chunking for non-BPM shells - conservative to prevent PTY/readline overwhelm
// PSReadLine does syntax highlighting, history, etc. on each character
const NON_BPM_CHUNK_SIZE = 512;
const NON_BPM_CHUNK_DELAY = 30;
// Only show paste indicator for pastes > 1KB
const PASTE_INDICATOR_THRESHOLD = 1024;
// Minimum badge display time so users can see it
const MIN_BADGE_DISPLAY_MS = 300;

/**
 * Send data in WebSocket-safe chunks without delays.
 * Used for BPM pastes where the shell buffers internally.
 */
function sendChunkedImmediate(sessionId: string, data: string): void {
  for (let i = 0; i < data.length; i += WS_MAX_PAYLOAD) {
    const chunk = data.slice(i, i + WS_MAX_PAYLOAD);
    sendInput(sessionId, chunk);
  }
}

/**
 * Send data in chunks with delays to prevent PTY buffer overflow.
 * Used for non-BPM shells that process input character-by-character.
 */
async function sendChunkedWithDelay(sessionId: string, data: string): Promise<void> {
  for (let i = 0; i < data.length; i += NON_BPM_CHUNK_SIZE) {
    const chunk = data.slice(i, i + NON_BPM_CHUNK_SIZE);
    sendInput(sessionId, chunk);
    if (i + NON_BPM_CHUNK_SIZE < data.length) {
      await new Promise((resolve) => setTimeout(resolve, NON_BPM_CHUNK_DELAY));
    }
  }
}

/**
 * Hide paste indicator after minimum display time.
 */
function hidePasteIndicatorDelayed(startTime: number): void {
  const elapsed = Date.now() - startTime;
  const remaining = MIN_BADGE_DISPLAY_MS - elapsed;
  if (remaining > 0) {
    setTimeout(hidePasteIndicator, remaining);
  } else {
    hidePasteIndicator();
  }
}

/**
 * Paste text to a terminal, wrapping with bracketed paste markers if enabled.
 * BPM state is tracked in muxChannel from live WebSocket data.
 *
 * Large pastes are chunked to stay within WebSocket frame limits (64KB backend).
 * BPM pastes chunk without delays (shell buffers); non-BPM chunk with delays.
 *
 * @param isFilePath - If true, wrap content in quotes for file path handling.
 */
export function pasteToTerminal(
  sessionId: string,
  data: string,
  isFilePath: boolean = false,
): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  const muxBpm = isBracketedPasteEnabled(sessionId);
  const xtermBpm = state.terminal.modes?.bracketedPasteMode ?? false;
  const bpmEnabled = muxBpm || xtermBpm;

  const content = isFilePath ? '"' + data + '"' : data;

  const showIndicator = content.length > PASTE_INDICATOR_THRESHOLD;
  const startTime = Date.now();
  if (showIndicator) {
    showPasteIndicator();
  }

  if (bpmEnabled) {
    // BPM: wrap with markers, chunk for WebSocket but no delays (shell buffers)
    const wrapped = '\x1b[200~' + content + '\x1b[201~';
    if (wrapped.length > WS_MAX_PAYLOAD) {
      // Large paste: send start marker, chunked content, end marker
      sendInput(sessionId, '\x1b[200~');
      sendChunkedImmediate(sessionId, content);
      sendInput(sessionId, '\x1b[201~');
    } else {
      sendInput(sessionId, wrapped);
    }
    if (showIndicator) {
      hidePasteIndicatorDelayed(startTime);
    }
  } else {
    // Non-BPM: chunk with delays to prevent PTY overflow
    if (content.length > NON_BPM_CHUNK_SIZE) {
      sendChunkedWithDelay(sessionId, content).then(() => {
        if (showIndicator) {
          hidePasteIndicatorDelayed(startTime);
        }
      });
    } else {
      sendInput(sessionId, content);
      if (showIndicator) {
        hidePasteIndicatorDelayed(startTime);
      }
    }
  }
}

/**
 * Scroll terminal to bottom - always show most recent output when switching sessions
 */
export function scrollToBottom(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state || !state.opened) return;
  state.terminal.scrollToBottom();
}

/**
 * Apply current settings to all existing terminals
 */
export function applySettingsToTerminals(): void {
  const options = getTerminalOptions();
  sessionTerminals.forEach((state) => {
    state.terminal.options.cursorBlink = options.cursorBlink ?? true;
    state.terminal.options.cursorStyle = options.cursorStyle ?? 'bar';
    state.terminal.options.fontSize = options.fontSize ?? 14;
    state.terminal.options.theme = options.theme ?? {};
  });
}

/**
 * Refresh the active terminal buffer by clearing and requesting via WebSocket.
 * Using WebSocket ensures the buffer arrives in-order with live terminal data.
 */
export function refreshActiveTerminalBuffer(): void {
  const activeId = $activeSessionId.get();
  if (!activeId) return;
  const state = sessionTerminals.get(activeId);
  if (state && state.opened) {
    state.terminal.clear();
    requestBufferRefresh(activeId);
  }
}

/**
 * Preload the terminal font for consistent rendering.
 * Has a 3-second timeout to prevent indefinite hangs if fonts fail to load.
 */
export function preloadTerminalFont(): Promise<void> {
  const FONT_TIMEOUT_MS = 3000;

  const fontLoadPromise = document.fonts.ready.then(() => {
    const testSpan = document.createElement('span');
    testSpan.style.fontFamily = TERMINAL_FONT_STACK;
    testSpan.style.position = 'absolute';
    testSpan.style.left = '-9999px';
    testSpan.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    document.body.appendChild(testSpan);

    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        testSpan.remove();
        resolve();
      });
    });
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, FONT_TIMEOUT_MS);
  });

  const promise = Promise.race([fontLoadPromise, timeoutPromise]);
  setFontsReadyPromise(promise);
  return promise;
}

/**
 * Initialize a hidden calibration terminal to get accurate cell measurements.
 * This creates a real xterm.js terminal, measures its rendered cell dimensions,
 * then disposes it. The measurement is used for sizing new terminals before
 * any real terminals exist.
 */
export function initCalibrationTerminal(): Promise<void> {
  calibrationPromise = new Promise((resolve) => {
    const container = document.createElement('div');
    container.style.cssText = `
      position: absolute;
      visibility: hidden;
      left: -9999px;
      width: 800px;
      height: 600px;
    `;
    document.body.appendChild(container);

    const terminal = new Terminal({
      ...getTerminalOptions(),
      cols: 80,
      rows: 24,
    });

    terminal.open(container);

    requestAnimationFrame(() => {
      const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
      if (screen && terminal.cols > 0 && terminal.rows > 0) {
        const cellWidth = screen.offsetWidth / terminal.cols;
        const cellHeight = screen.offsetHeight / terminal.rows;
        if (cellWidth >= 1 && cellHeight >= 1) {
          calibrationMeasurement = { cellWidth, cellHeight };
          console.log(
            `[CALIBRATION] Cell size: ${cellWidth.toFixed(2)}×${cellHeight.toFixed(2)} px`,
          );
        }
      }

      terminal.dispose();
      container.remove();
      resolve();
    });
  });
  return calibrationPromise;
}

/**
 * Get the calibration measurement from the hidden terminal.
 * Returns null if calibration hasn't run or failed.
 */
export function getCalibrationMeasurement(): { cellWidth: number; cellHeight: number } | null {
  return calibrationMeasurement;
}

/**
 * Get the promise that resolves when calibration is complete.
 * Returns null if calibration hasn't been started.
 */
export function getCalibrationPromise(): Promise<void> | null {
  return calibrationPromise;
}
