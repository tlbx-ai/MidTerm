/**
 * Terminal Manager Module
 *
 * Handles xterm.js terminal lifecycle, creation, destruction,
 * and event binding for terminal sessions.
 */

import type { Session, TerminalState } from '../../types';
import { THEMES } from '../../constants';
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
import { getClipboardStyle } from '../../utils';
import { applyTerminalScaling, fitSessionToScreen } from './scaling';
import { setupFileDrop, handleClipboardPaste } from './fileDrop';

declare const Terminal: any;
declare const FitAddon: any;
declare const WebglAddon: any;
declare const WebLinksAddon: any;
declare const SearchAddon: any;

import { initSearchForTerminal, showSearch, isSearchVisible, hideSearch } from './search';

// Forward declarations for functions from other modules
let sendInput: (sessionId: string, data: string) => void = () => {};
let showBellNotification: (sessionId: string) => void = () => {};

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
}): void {
  if (callbacks.sendInput) sendInput = callbacks.sendInput;
  if (callbacks.showBellNotification) showBellNotification = callbacks.showBellNotification;
}

/**
 * Get terminal options based on current settings
 */
export function getTerminalOptions(): object {
  const isMobile = window.innerWidth <= 768;
  const baseFontSize = currentSettings?.fontSize ?? 14;
  const fontSize = isMobile ? Math.max(baseFontSize - 2, 10) : baseFontSize;
  const themeName = currentSettings?.theme ?? 'dark';
  const fontFamily = currentSettings?.fontFamily ?? 'Cascadia Code';

  const options: Record<string, unknown> = {
    cursorBlink: currentSettings?.cursorBlink ?? true,
    cursorStyle: currentSettings?.cursorStyle ?? 'bar',
    fontFamily: `'${fontFamily}', 'Cascadia Mono', Consolas, 'Courier New', monospace`,
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
  // Parse dimensions from output frame: [cols:2][rows:2][data]
  const frameCols = payload[0] | (payload[1] << 8);
  const frameRows = payload[2] | (payload[3] << 8);
  const terminalData = payload.slice(4);

  // Validate dimensions are within sane bounds (1-500)
  const validDims = frameCols > 0 && frameCols <= 500 && frameRows > 0 && frameRows <= 500;

  // Ensure terminal matches frame dimensions before writing
  if (validDims && state.terminal._core && state.terminal._core._renderService) {
    const currentCols = state.terminal.cols;
    const currentRows = state.terminal.rows;

    if (currentCols !== frameCols || currentRows !== frameRows) {
      try {
        state.terminal.resize(frameCols, frameRows);
        state.serverCols = frameCols;
        state.serverRows = frameRows;
        applyTerminalScaling(sessionId, state);
      } catch (e) {
        // Ignore resize errors
      }
    }
  }

  // Write terminal data
  if (terminalData.length > 0) {
    state.terminal.write(terminalData);
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
  const pasteHandler = (e: ClipboardEvent) => {
    e.preventDefault();
  };
  container.addEventListener('paste', pasteHandler);

  // Right-click paste (images uploaded, text pasted)
  const contextMenuHandler = (e: MouseEvent) => {
    if (!currentSettings || currentSettings.rightClickPaste !== false) {
      e.preventDefault();
      handleClipboardPaste(sessionId);
    }
  };

  container.addEventListener('contextmenu', contextMenuHandler);

  // Store handler reference for cleanup
  const state = sessionTerminals.get(sessionId);
  if (state) {
    state.contextMenuHandler = contextMenuHandler;
  }
}

/**
 * Destroy a terminal for a session and clean up resources
 */
export function destroyTerminalForSession(sessionId: string): void {
  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  // Remove context menu handler if exists
  if (state.contextMenuHandler) {
    state.container.removeEventListener('contextmenu', state.contextMenuHandler);
  }

  state.terminal.dispose();
  state.container.remove();
  sessionTerminals.delete(sessionId);
  pendingOutputFrames.delete(sessionId);
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
 * Fetch and write terminal buffer from server
 */
export function fetchAndWriteBuffer(sessionId: string, terminal: any): void {
  fetch('/api/sessions/' + sessionId + '/buffer')
    .then((response) => {
      return response.ok ? response.text() : '';
    })
    .then((buffer) => {
      if (buffer) {
        terminal.write(buffer);
      }
    })
    .catch((e) => {
      console.error('Error fetching buffer:', e);
    });
}

/**
 * Refresh the active terminal buffer by clearing and re-fetching
 */
export function refreshActiveTerminalBuffer(): void {
  if (!activeSessionId) return;
  const state = sessionTerminals.get(activeSessionId);
  if (state && state.opened) {
    // Clear and re-fetch the entire buffer to ensure consistency
    state.terminal.clear();
    fetchAndWriteBuffer(activeSessionId, state.terminal);
  }
}

/**
 * Preload the terminal font for consistent rendering
 */
export function preloadTerminalFont(): Promise<void> {
  const promise = document.fonts.ready.then(() => {
    // Trigger font load by measuring with the font family
    const testSpan = document.createElement('span');
    testSpan.style.fontFamily = "'Cascadia Code', 'Cascadia Mono', Consolas, monospace";
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
