/**
 * Terminal Manager Module
 *
 * Handles xterm.js terminal lifecycle, creation, destruction,
 * and event binding for terminal sessions.
 */

import type { Session, TerminalState } from '../../types';
import { THEMES, MOBILE_BREAKPOINT, TERMINAL_FONT_STACK } from '../../constants';
import {
  sessionTerminals,
  currentSettings,
  activeSessionId,
  pendingOutputFrames,
  fontsReadyPromise,
  dom,
  setFontsReadyPromise,
  windowsBuildNumber,
  sessions
} from '../../state';
import { getClipboardStyle, parseOutputFrame } from '../../utils';
import { applyTerminalScaling, fitSessionToScreen } from './scaling';
import { setupFileDrop, handleClipboardPaste } from './fileDrop';

declare const Terminal: any;
declare const FitAddon: any;
declare const WebglAddon: any;
declare const WebLinksAddon: any;
declare const SearchAddon: any;

import { initSearchForTerminal, showSearch, isSearchVisible, hideSearch, cleanupSearchForTerminal } from './search';

// Forward declarations for functions from other modules
let sendInput: (sessionId: string, data: string) => void = () => {};
let showBellNotification: (sessionId: string) => void = () => {};
let requestBufferRefresh: (sessionId: string) => void = () => {};

// Debounce timers for auto-rename from shell title
const pendingTitleUpdates = new Map<string, number>();

/**
 * Bracketed Paste Mode (BPM) State Tracking
 *
 * BPM allows TUI apps to distinguish pasted text from typed input by wrapping
 * pastes with escape sequences: ESC[200~ (start) and ESC[201~ (end).
 *
 * HOW IT WORKS WITH COMPLEX TUIs (e.g., Claude Code):
 * 1. Shell/app enables BPM by outputting ESC[?2004h
 * 2. We detect this in terminal output and track state per session
 * 3. When user pastes (or drops file), we wrap content with BPM markers
 * 4. TUI app receives markers and knows it's pasted content
 *
 * IMAGE DRAG-DROP TO CLAUDE CODE:
 * Claude Code detects dropped images via string heuristics - it pattern-matches
 * for file paths like: ^"?[A-Z]:\\.*?\.(png|jpg|jpeg|webp|gif)"?$
 * When detected, it reads the file and adds it to context as an image.
 *
 * CRITICAL FOR WINDOWS: Claude Code checks environment variables to detect
 * if it's running in Windows Terminal. See ShellConfigurations.cs for details.
 * - WT_PROFILE_ID must have curly braces: {guid-here}
 * - TERM and COLORTERM must NOT be set (Windows Terminal doesn't set them)
 *
 * FOR MAC/LINUX TESTING: The env var requirements may differ. Start by checking
 * what environment a native terminal sets, then match it in ShellConfigurations.cs.
 * The BPM mechanism itself should work the same across platforms.
 *
 * We track BPM ourselves AND check xterm.js internal state as fallback because
 * xterm.js detection alone proved unreliable in some scenarios.
 */
const bracketedPasteState = new Map<string, boolean>();

/**
 * Auto-update session name from shell title (with debounce)
 */
function updateSessionNameAuto(sessionId: string, name: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (session?.manuallyNamed) return;

  const existing = pendingTitleUpdates.get(sessionId);
  if (existing) {
    window.clearTimeout(existing);
  }

  const timer = window.setTimeout(() => {
    pendingTitleUpdates.delete(sessionId);
    fetch(`/api/sessions/${sessionId}/name?auto=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).catch(() => {});
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
export function getTerminalOptions(): object {
  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  const baseFontSize = currentSettings?.fontSize ?? 14;
  const fontSize = isMobile ? Math.max(baseFontSize - 2, 10) : baseFontSize;
  const themeName = currentSettings?.theme ?? 'dark';
  const fontFamily = currentSettings?.fontFamily ?? 'Cascadia Code';

  const options: Record<string, unknown> = {
    cursorBlink: currentSettings?.cursorBlink ?? true,
    cursorStyle: currentSettings?.cursorStyle ?? 'bar',
    fontFamily: `'${fontFamily}', ${TERMINAL_FONT_STACK}`,
    fontSize: fontSize,
    letterSpacing: 0,
    lineHeight: 1,
    scrollback: currentSettings?.scrollbackLines ?? 10000,
    minimumContrastRatio: currentSettings?.minimumContrastRatio ?? 1,
    smoothScrollDuration: currentSettings?.smoothScrolling ? 150 : 0,
    allowProposedApi: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    theme: THEMES[themeName] ?? THEMES.dark
  };

  if (windowsBuildNumber !== null) {
    options.windowsPty = {
      backend: 'conpty',
      buildNumber: windowsBuildNumber
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
  sessionInfo: Session | undefined
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
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  // Get server dimensions from session info (if available)
  const serverCols = sessionInfo && sessionInfo.cols > 0 ? sessionInfo.cols : 0;
  const serverRows = sessionInfo && sessionInfo.rows > 0 ? sessionInfo.rows : 0;

  const state: TerminalState = {
    terminal: terminal,
    fitAddon: fitAddon,
    container: container,
    serverCols: serverCols,
    serverRows: serverRows,
    opened: false
  };

  sessionTerminals.set(sessionId, state);

  // Wait for fonts to be ready before opening terminal
  // This ensures xterm.js measures the correct font for canvas rendering
  (fontsReadyPromise ?? Promise.resolve()).then(() => {
    if (!sessionTerminals.has(sessionId)) return; // Session was deleted
    terminal.open(container);
    state.opened = true;

    // Load WebGL addon for GPU-accelerated rendering (with fallback)
    if (currentSettings?.useWebGL !== false) {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        webglAddon.onContextLost(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, using canvas renderer
      }
    }

    // Load Web-Links addon for clickable URLs
    try {
      const webLinksAddon = new WebLinksAddon.WebLinksAddon(
        (_event: MouseEvent, uri: string) => {
          if (uri.startsWith('http://') || uri.startsWith('https://')) {
            window.open(uri, '_blank', 'noopener,noreferrer');
          }
        }
      );
      terminal.loadAddon(webLinksAddon);
    } catch {
      // Web-Links addon failed to load
    }

    // Load Search addon for Ctrl+F search
    initSearchForTerminal(sessionId, terminal);

    // Replay any WebSocket frames that arrived before terminal was opened
    replayPendingFrames(sessionId, state);

    // Defer resize to next frame - xterm.js needs a frame to fully initialize after open()
    requestAnimationFrame(() => {
      if (!sessionTerminals.has(sessionId)) return; // Session was deleted

      // Fit terminal to current viewport using actual measured cell dimensions
      fitSessionToScreen(sessionId);

      setupTerminalEvents(sessionId, terminal, container);
    });
  });

  return state;
}

/**
 * Replay pending output frames that arrived before terminal was opened
 */
function replayPendingFrames(sessionId: string, state: TerminalState): void {
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
  payload: Uint8Array
): void {
  const frame = parseOutputFrame(payload);

  // Track bracketed paste mode by detecting escape sequences in output
  // Apps send \x1b[?2004h to enable and \x1b[?2004l to disable
  if (frame.data.length > 0) {
    const text = new TextDecoder().decode(frame.data);

    // Check for bracketed paste mode sequences (multiple formats)
    // ESC[?2004h = enable, ESC[?2004l = disable
    const enableMatch = text.includes('\x1b[?2004h') || text.includes('\u001b[?2004h');
    const disableMatch = text.includes('\x1b[?2004l') || text.includes('\u001b[?2004l');

    if (enableMatch) {
      bracketedPasteState.set(sessionId, true);
    }
    if (disableMatch) {
      bracketedPasteState.set(sessionId, false);
    }
  }

  // Ensure terminal matches frame dimensions before writing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (state.terminal as any)._core;
  if (frame.valid && core && core._renderService) {
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
  }
}

/**
 * Set up terminal event handlers for input, bell, selection, etc.
 */
export function setupTerminalEvents(
  sessionId: string,
  terminal: any,
  container: HTMLDivElement
): void {
  // Wire up events
  terminal.onData((data: string) => {
    sendInput(sessionId, data);
  });

  terminal.onBell(() => {
    showBellNotification(sessionId);
  });

  terminal.onSelectionChange(() => {
    if (currentSettings?.copyOnSelect && terminal.hasSelection()) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
    }
  });

  // Auto-update session name from shell title
  terminal.onTitleChange((title: string) => {
    if (title && title.trim()) {
      updateSessionNameAuto(sessionId, title.trim());
    }
  });

  // Keyboard shortcuts for copy/paste
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;

    // Ctrl+Enter: Send LF (\n) instead of CR (\r) for TUI apps that use it for line breaks
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'Enter') {
      sendInput(sessionId, '\n');
      return false;
    }

    const style = getClipboardStyle(currentSettings?.clipboardShortcuts ?? 'auto');

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
        handleClipboardPaste(sessionId);
        return false;
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
        handleClipboardPaste(sessionId);
        return false;
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

  // Prevent browser paste event - we handle it ourselves via handleClipboardPaste
  // This prevents xterm.js from also handling paste via onData
  // Use capture phase to intercept before xterm.js
  const pasteHandler = (e: ClipboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  container.addEventListener('paste', pasteHandler, true);

  // Right-click paste (images uploaded, text pasted)
  const contextMenuHandler = (e: MouseEvent) => {
    if (!currentSettings || currentSettings.rightClickPaste !== false) {
      e.preventDefault();
      handleClipboardPaste(sessionId);
    }
  };

  container.addEventListener('contextmenu', contextMenuHandler);

  // Store handler references for cleanup
  const state = sessionTerminals.get(sessionId);
  if (state) {
    state.contextMenuHandler = contextMenuHandler;
    state.pasteHandler = pasteHandler;
  }
}

/**
 * Destroy a terminal for a session and clean up resources
 */
export function destroyTerminalForSession(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Clean up event listeners
  if (state.contextMenuHandler) {
    state.container.removeEventListener('contextmenu', state.contextMenuHandler);
  }
  if (state.pasteHandler) {
    state.container.removeEventListener('paste', state.pasteHandler, true);
  }

  // Clean up search addon state
  cleanupSearchForTerminal(sessionId);

  // Clean up pending title update timer
  const titleTimer = pendingTitleUpdates.get(sessionId);
  if (titleTimer) {
    clearTimeout(titleTimer);
    pendingTitleUpdates.delete(sessionId);
  }

  state.terminal.dispose();
  state.container.remove();
  sessionTerminals.delete(sessionId);
  pendingOutputFrames.delete(sessionId);
  bracketedPasteState.delete(sessionId);
}

/**
 * Paste text to a terminal, wrapping with bracketed paste markers if enabled.
 * We track BPM state ourselves to ensure reliable paste handling for TUI apps.
 *
 * @param isFilePath - If true, wrap content in quotes for file path handling.
 *                     This helps TUI apps like Claude Code detect file paths with spaces.
 */
export function pasteToTerminal(sessionId: string, data: string, isFilePath: boolean = false): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Check both our tracking and xterm.js internal state
  const ourBpm = bracketedPasteState.get(sessionId) ?? false;
  const xtermBpm = (state.terminal as any).modes?.bracketedPasteMode ?? false;
  const bpmEnabled = ourBpm || xtermBpm;

  if (bpmEnabled) {
    // Manually wrap with bracketed paste sequences and send via input
    // Only quote file paths (for Claude Code image detection with spaces in path)
    const content = isFilePath ? '"' + data + '"' : data;
    const wrapped = '\x1b[200~' + content + '\x1b[201~';
    sendInput(sessionId, wrapped);
  } else {
    // No bracketed paste mode - use standard paste
    state.terminal.paste(data);
  }
}

/**
 * Apply current settings to all existing terminals
 */
export function applySettingsToTerminals(): void {
  const options = getTerminalOptions();
  sessionTerminals.forEach((state) => {
    state.terminal.options.cursorBlink = (options as any).cursorBlink;
    state.terminal.options.cursorStyle = (options as any).cursorStyle;
    state.terminal.options.fontSize = (options as any).fontSize;
    state.terminal.options.theme = (options as any).theme;
  });
}

/**
 * Refresh the active terminal buffer by clearing and requesting via WebSocket.
 * Using WebSocket ensures the buffer arrives in-order with live terminal data.
 */
export function refreshActiveTerminalBuffer(): void {
  if (!activeSessionId) return;
  const state = sessionTerminals.get(activeSessionId);
  if (state && state.opened) {
    state.terminal.clear();
    requestBufferRefresh(activeSessionId);
  }
}

/**
 * Preload the terminal font for consistent rendering
 */
export function preloadTerminalFont(): Promise<void> {
  const promise = document.fonts.ready.then(() => {
    // Trigger font load by measuring with the font family
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

  setFontsReadyPromise(promise);
  return promise;
}
