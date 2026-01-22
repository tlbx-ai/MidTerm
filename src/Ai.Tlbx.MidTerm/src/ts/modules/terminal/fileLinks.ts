/**
 * File Links Module
 *
 * Detects file paths in terminal output and makes them clickable.
 * Only paths that have been seen in terminal output are clickable (allowlist).
 * Clicking opens the file viewer modal.
 */

/* =============================================================================
 * PERFORMANCE-SENSITIVE CODE - FILE PATH DETECTION
 * =============================================================================
 *
 * This module scans ALL terminal output for file paths. It runs on every frame
 * of terminal data, which can be frequent during:
 *   - TUI apps (vim, htop, less) with rapid redraws
 *   - Large file outputs (cat, logs, builds)
 *   - High-frequency updates (tail -f, watch)
 *
 * OPTIMIZATIONS APPLIED:
 *   1. Reused TextDecoder instance (avoid allocation per frame)
 *   2. Minimum frame size threshold (skip tiny cursor-move frames)
 *   3. Debounced scanning (batch rapid frames, run in idle time)
 *   4. Reused regex patterns (no new RegExp per call)
 *   5. Early bailout for frames with no path-like characters
 *
 * IF UI PERFORMANCE DEGRADES:
 *   - Increase MIN_SCAN_FRAME_SIZE to skip more small frames
 *   - Increase SCAN_DEBOUNCE_MS to batch more aggressively
 *   - Disable via Settings > Behavior > "File Radar (experimental)"
 *   - Or comment out scanOutputForPaths() call in manager.ts
 *
 * =========================================================================== */

import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm';
import type { FilePathInfo, FileCheckResponse } from '../../types';
import { openFile } from '../fileViewer';
import { createLogger } from '../logging';
import { currentSettings } from '../../state';

const log = createLogger('fileLinks');

// ===========================================================================
// PERFORMANCE TUNING CONSTANTS - Adjust these if performance degrades
// ===========================================================================

/**
 * Check if File Radar is enabled via settings.
 * Controlled by Settings > Behavior > "File Radar (experimental)"
 * Default: OFF - user must explicitly enable this feature.
 */
function isFileRadarEnabled(): boolean {
  return currentSettings?.fileRadar === true;
}

/** Minimum frame size in bytes to bother scanning (skip tiny cursor moves) */
const MIN_SCAN_FRAME_SIZE = 8;

/** Debounce interval for batching rapid terminal output (ms) */
const SCAN_DEBOUNCE_MS = 50;

/** Maximum paths to track per session (FIFO eviction) */
const MAX_ALLOWLIST_SIZE = 1000;

/** Cache TTL for file existence checks (ms) */
const EXISTENCE_CACHE_TTL = 30000;

/** Quick check: does the text contain characters that could be a path? */
const QUICK_PATH_CHECK_UNIX = /\//;
const QUICK_PATH_CHECK_WIN = /[A-Za-z]:/;

// ===========================================================================
// Module State
// ===========================================================================

const pathAllowlists = new Map<string, Set<string>>();
const existenceCache = new Map<string, { info: FilePathInfo | null; expires: number }>();

/** Reused TextDecoder to avoid allocation per frame */
const textDecoder = new TextDecoder();

/** Pending text to scan per session (for debouncing) */
const pendingScanText = new Map<string, string>();

/** Debounce timers per session */
const scanTimers = new Map<string, number>();

// ===========================================================================
// Regex Patterns - Compiled once at module load
// ===========================================================================

/**
 * Unix absolute paths: /path/to/file or /path/to/file.ext
 * Uses non-global version for matchAll (creates fresh iterator each time)
 */
const UNIX_PATH_PATTERN = /(?:^|[\s"'`(])(\/([\w.-]+\/)*[\w.-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;

/**
 * Windows absolute paths: C:\path\file or C:/path/file
 * Uses non-global version for matchAll (creates fresh iterator each time)
 */
const WIN_PATH_PATTERN =
  /(?:^|[\s"'`(])([A-Za-z]:[\\/](?:[\w.-]+[\\/])*[\w.-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;

// ===========================================================================
// Public API
// ===========================================================================

export function getPathAllowlist(sessionId: string): Set<string> {
  let allowlist = pathAllowlists.get(sessionId);
  if (!allowlist) {
    allowlist = new Set();
    pathAllowlists.set(sessionId, allowlist);
  }
  return allowlist;
}

export function clearPathAllowlist(sessionId: string): void {
  pathAllowlists.delete(sessionId);
  // Also clear any pending scan
  const timer = scanTimers.get(sessionId);
  if (timer) {
    window.clearTimeout(timer);
    scanTimers.delete(sessionId);
  }
  pendingScanText.delete(sessionId);
}

/**
 * Queue terminal output for path scanning.
 * Debounced to batch rapid frames and reduce CPU overhead.
 *
 * PERFORMANCE NOTE: This is called on EVERY terminal output frame.
 * Keep this function as fast as possible - actual scanning is deferred.
 */
export function scanOutputForPaths(sessionId: string, data: string | Uint8Array): void {
  const enabled = isFileRadarEnabled();
  console.log(`[DIAG] scanOutputForPaths: enabled=${enabled}, dataLen=${data.length}`);
  if (!enabled) {
    return;
  }

  // Decode if needed (reuse decoder to avoid allocation)
  const text = typeof data === 'string' ? data : textDecoder.decode(data);

  // Skip tiny frames (likely cursor moves, not real content)
  if (text.length < MIN_SCAN_FRAME_SIZE) return;

  const hasUnix = QUICK_PATH_CHECK_UNIX.test(text);
  const hasWin = QUICK_PATH_CHECK_WIN.test(text);
  console.log(
    `[DIAG] quickCheck: unix=${hasUnix}, win=${hasWin}, text="${text.substring(0, 100)}"`,
  );

  // Quick check: does this text even contain path-like characters?
  // This avoids regex overhead for frames that are clearly not paths
  if (!hasUnix && !hasWin) {
    return;
  }

  // Append to pending text for this session
  const existing = pendingScanText.get(sessionId) || '';
  pendingScanText.set(sessionId, existing + text);
  console.log(`[DIAG] accumulated: len=${(existing + text).length}`);

  // Debounce: reset timer and schedule scan
  const existingTimer = scanTimers.get(sessionId);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(() => {
    scanTimers.delete(sessionId);
    const pendingText = pendingScanText.get(sessionId);
    pendingScanText.delete(sessionId);
    if (pendingText) {
      performScan(sessionId, pendingText);
    }
  }, SCAN_DEBOUNCE_MS);

  scanTimers.set(sessionId, timer);
}

// ===========================================================================
// Internal Implementation
// ===========================================================================

/**
 * Actually perform the regex scan on accumulated text.
 * Called after debounce delay, potentially in idle time.
 */
function performScan(sessionId: string, text: string): void {
  // Strip ANSI escape sequences before regex matching
  // Handles CSI sequences (colors, cursor), OSC sequences (hyperlinks, titles), and other controls
  /* eslint-disable no-control-regex */
  const cleanText = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // CSI sequences: \x1b[...m, \x1b[...H, etc.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences: \x1b]...BEL or \x1b]...\x1b\\
    .replace(/\x1b\][^\x07]*/g, ''); // Incomplete OSC (no terminator yet)
  /* eslint-enable no-control-regex */

  console.log(`[DIAG] performScan: cleanText="${cleanText.substring(0, 200)}"`);

  const allowlist = getPathAllowlist(sessionId);
  const initialSize = allowlist.size;

  // Reset regex lastIndex and scan for Unix paths
  UNIX_PATH_PATTERN.lastIndex = 0;
  for (const match of cleanText.matchAll(UNIX_PATH_PATTERN)) {
    const path = match[1];
    if (!path) continue;
    log.info(() => `Unix match: "${path}" valid=${isValidPath(path)}`);
    if (isValidPath(path)) {
      addToAllowlist(allowlist, path);
    }
  }

  // Reset regex lastIndex and scan for Windows paths
  WIN_PATH_PATTERN.lastIndex = 0;
  for (const match of cleanText.matchAll(WIN_PATH_PATTERN)) {
    const path = match[1];
    if (!path) continue;
    console.log(`[DIAG] Windows match: "${path}" valid=${isValidPath(path)}`);
    if (isValidPath(path)) {
      addToAllowlist(allowlist, path);
    }
  }

  if (allowlist.size > initialSize) {
    log.info(
      () => `Added ${allowlist.size - initialSize} paths to allowlist for session ${sessionId}`,
    );
  }
}

function addToAllowlist(allowlist: Set<string>, path: string): void {
  if (allowlist.size >= MAX_ALLOWLIST_SIZE) {
    // FIFO eviction - remove oldest entry
    const firstKey = allowlist.values().next().value;
    if (firstKey) allowlist.delete(firstKey);
  }
  allowlist.add(path);
}

function isValidPath(path: string): boolean {
  if (!path || path.length < 2) return false;
  if (path.includes('..')) return false;
  // Reject simple Unix commands that look like paths (e.g., /bin, /usr)
  if (/^\/[a-z]+$/.test(path)) return false;
  return true;
}

async function checkPathExists(path: string): Promise<FilePathInfo | null> {
  const cached = existenceCache.get(path);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }

  try {
    const resp = await fetch('/api/files/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    });

    if (!resp.ok) {
      existenceCache.set(path, { info: null, expires: Date.now() + EXISTENCE_CACHE_TTL });
      return null;
    }

    const data: FileCheckResponse = await resp.json();
    const info = data.results[path] || null;

    existenceCache.set(path, { info, expires: Date.now() + EXISTENCE_CACHE_TTL });
    return info;
  } catch (e) {
    log.error(() => `Failed to check path existence: ${e}`);
    return null;
  }
}

// ===========================================================================
// Link Provider Registration
// ===========================================================================

export function createFileLinkProvider(sessionId: string): ILinkProvider {
  return {
    provideLinks(_lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      if (!isFileRadarEnabled()) {
        callback(undefined);
        return;
      }
      const allowlist = getPathAllowlist(sessionId);
      if (allowlist.size === 0) {
        callback(undefined);
        return;
      }
      callback(undefined);
    },
  };
}

/**
 * Register the file link provider with xterm.js.
 * This is called once per terminal session.
 * NOTE: Always registers the provider - setting is checked inside the callback
 * so toggling the setting works without recreating terminals.
 */
export function registerFileLinkProvider(terminal: Terminal, sessionId: string): void {
  const allowlist = getPathAllowlist(sessionId);

  terminal.registerLinkProvider({
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      console.log(
        `[DIAG] provideLinks ENTRY: session=${sessionId}, line=${lineNumber}, allowlist=${allowlist.size}`,
      );

      // Check setting inside callback so toggling works without recreating terminals
      if (!isFileRadarEnabled()) {
        callback(undefined);
        return;
      }

      // Early bailout if no paths detected yet
      if (allowlist.size === 0) {
        console.log(`[DIAG] provideLinks: empty allowlist, skipping`);
        callback(undefined);
        return;
      }

      const buffer = terminal.buffer.active;
      const line = buffer.getLine(lineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      console.log(
        `[DIAG] provideLinks: line=${lineNumber}, allowlist=${allowlist.size}, text="${lineText.substring(0, 80)}"`,
      );

      // Quick check before regex - does line contain path-like chars?
      if (!QUICK_PATH_CHECK_UNIX.test(lineText) && !QUICK_PATH_CHECK_WIN.test(lineText)) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];

      // Scan with reused patterns (reset lastIndex for safety with global flag)
      const findLinks = (pattern: RegExp) => {
        pattern.lastIndex = 0;
        for (const match of lineText.matchAll(pattern)) {
          const path = match[1];
          if (!path) continue;
          if (!allowlist.has(path)) continue;

          const matchStart = match.index! + match[0].indexOf(path);
          const matchEnd = matchStart + path.length;

          links.push({
            range: {
              start: { x: matchStart + 1, y: lineNumber + 1 },
              end: { x: matchEnd + 1, y: lineNumber + 1 },
            },
            text: path,
            decorations: {
              pointerCursor: true,
              underline: true,
            },
            activate: async (_event: MouseEvent, text: string) => {
              log.info(() => `Opening file: ${text}`);
              const info = await checkPathExists(text);
              if (info && info.exists) {
                openFile(text, info);
              } else {
                log.warn(() => `File not found or inaccessible: ${text}`);
              }
            },
            hover: async (_event: MouseEvent, text: string) => {
              // Pre-fetch existence on hover for faster click response
              await checkPathExists(text);
            },
          });
        }
      };

      findLinks(UNIX_PATH_PATTERN);
      findLinks(WIN_PATH_PATTERN);

      callback(links.length > 0 ? links : undefined);
    },
  });

  log.info(() => `Registered file link provider for session ${sessionId}`);
}
