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
  sessionsNeedingResync,
  fontsReadyPromise,
  dom,
  setFontsReadyPromise,
  windowsBuildNumber,
  sessions
} from '../../state';
import { getClipboardStyle, parseOutputFrame } from '../../utils';
import { applyTerminalScaling, fitSessionToScreen } from './scaling';
import { setupFileDrop, handleClipboardPaste, sanitizePasteContent } from './fileDrop';
import { isBracketedPasteEnabled } from '../comms';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { initSearchForTerminal, showSearch, isSearchVisible, hideSearch, cleanupSearchForTerminal } from './search';

// Forward declarations for functions from other modules
let sendInput: (sessionId: string, data: string) => void = () => {};
let showBellNotification: (sessionId: string) => void = () => {};
let requestBufferRefresh: (sessionId: string) => void = () => {};

// Debounce timers for auto-rename from shell title
const pendingTitleUpdates = new Map<string, number>();

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
    cursorInactiveStyle: 'none',
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

  // Configure ConPTY for Windows - use server-provided build or detect from userAgent
  const isWindows = /Windows|Win32|Win64/i.test(navigator.userAgent);
  if (windowsBuildNumber !== null) {
    options.windowsPty = {
      backend: 'conpty',
      buildNumber: windowsBuildNumber
    };
  } else if (isWindows) {
    // Default to Windows 10 2004 (19041) which has stable ConPTY support
    // This ensures proper VT sequence interpretation before health check completes
    options.windowsPty = {
      backend: 'conpty',
      buildNumber: 19041
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
  const fitAddon = new FitAddon();
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
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, using canvas renderer
      }
    }

    // Load Web-Links addon for clickable URLs
    try {
      const webLinksAddon = new WebLinksAddon(
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
  payload: Uint8Array
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
  sessionsNeedingResync.delete(sessionId);
}

// Chunking constants for large pastes to prevent PTY buffer overflow
// PSReadLine processes input slowly (syntax highlighting, history, etc.)
// Small chunks + delay give it time to keep up
const PASTE_CHUNK_SIZE = 128;  // 128 byte chunks
const PASTE_CHUNK_DELAY = 100; // 100ms between chunks

/**
 * Send data in chunks with delays to prevent PTY buffer overflow.
 * Used for large pastes (> 4KB) to avoid cursor corruption.
 */
async function sendChunked(sessionId: string, data: string): Promise<void> {
  for (let i = 0; i < data.length; i += PASTE_CHUNK_SIZE) {
    const chunk = data.slice(i, i + PASTE_CHUNK_SIZE);
    sendInput(sessionId, chunk);
    if (i + PASTE_CHUNK_SIZE < data.length) {
      await new Promise(resolve => setTimeout(resolve, PASTE_CHUNK_DELAY));
    }
  }
}

/**
 * Paste text to a terminal, wrapping with bracketed paste markers if enabled.
 * BPM state is tracked in muxChannel from live WebSocket data.
 *
 * Large pastes (> 4KB) are chunked with delays to prevent PTY buffer overflow
 * which can cause cursor corruption and data loss.
 *
 * @param isFilePath - If true, wrap content in quotes for file path handling.
 *                     This helps TUI apps like Claude Code detect file paths with spaces.
 */
export function pasteToTerminal(sessionId: string, data: string, isFilePath: boolean = false): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Check BPM state from muxChannel (live WebSocket tracking) and xterm.js internal state
  const muxBpm = isBracketedPasteEnabled(sessionId);
  const xtermBpm = (state.terminal as any).modes?.bracketedPasteMode ?? false;
  const bpmEnabled = muxBpm || xtermBpm;

  // Prepare content
  const content = isFilePath ? '"' + data + '"' : data;

  if (bpmEnabled) {
    // Wrap with bracketed paste sequences
    const wrapped = '\x1b[200~' + content + '\x1b[201~';
    if (wrapped.length > PASTE_CHUNK_SIZE) {
      // Large paste: send BPM start, chunked content, BPM end
      sendInput(sessionId, '\x1b[200~');
      sendChunked(sessionId, content).then(() => {
        sendInput(sessionId, '\x1b[201~');
      });
    } else {
      sendInput(sessionId, wrapped);
    }
  } else {
    // No bracketed paste mode
    if (content.length > PASTE_CHUNK_SIZE) {
      sendChunked(sessionId, content);
    } else {
      sendInput(sessionId, content);
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
