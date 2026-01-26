/**
 * File Links Module
 *
 * Detects file paths in terminal output and makes them clickable.
 * Uses xterm-link-provider for robust link detection and rendering.
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
 *   - Disable via Settings > Behavior > "File Radar"
 *   - Or comment out scanOutputForPaths() call in manager.ts
 *
 * =========================================================================== */

import type { Terminal } from '@xterm/xterm';
import { LinkProvider } from 'xterm-link-provider';
import type { FilePathInfo, FileCheckResponse, FileResolveResponse } from '../../types';
import { openFile } from '../fileViewer';
import { createLogger } from '../logging';
import { $activeSessionId, $currentSettings } from '../../stores';

const log = createLogger('fileLinks');

// ===========================================================================
// PERFORMANCE TUNING CONSTANTS - Adjust these if performance degrades
// ===========================================================================

/**
 * Check if File Radar is enabled via settings.
 * Controlled by Settings > Behavior > "File Radar"
 * Default: ON (true if settings not yet loaded, since server default is true)
 */
function isFileRadarEnabled(): boolean {
  const settings = $currentSettings.get();
  if (settings === null) return true;
  return settings.fileRadar === true;
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
 * Pattern for xterm-link-provider (uses capture group 1 for the link text)
 * Negative lookbehind prevents matching /foo/bar inside src/foo/bar (relative paths)
 */
const UNIX_PATH_PATTERN = /(?<![a-zA-Z0-9_.-])(\/(?:[\w.-]+\/)*[\w.-]+(?:\.\w+)?)/;

/**
 * Windows absolute paths: C:\path\file or C:/path/file
 * Pattern for xterm-link-provider (uses capture group 1 for the link text)
 */
const WIN_PATH_PATTERN = /([A-Za-z]:[\\/](?:[\w.-]+[\\/])*[\w.-]+(?:\.\w+)?)/;

/**
 * Global versions for scanning terminal output
 */
const UNIX_PATH_PATTERN_GLOBAL = /(?:^|[\s"'`(])(\/([\w.-]+\/)*[\w.-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;
const WIN_PATH_PATTERN_GLOBAL =
  /(?:^|[\s"'`(])([A-Za-z]:[\\/](?:[\w.-]+[\\/])*[\w.-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;

/**
 * Relative path pattern - matches any filename.extension pattern.
 * Resolves against session's working directory on hover (lazy filesystem access).
 *
 * Matches: output.pdf, ./data.json, src/main.ts, src\Ai\Services\Foo.cs
 * Does NOT match: package (no extension), http://... (URLs)
 * False positives (1.2.3, e.g., google.com) filtered by isLikelyFalsePositive()
 *
 * Extension: 1-10 chars, must start with letter (avoids matching "file.1" or pure numbers)
 * Supports both / and \ path separators for cross-platform compatibility.
 */
const RELATIVE_PATH_PATTERN = /((?:\.\.?[/\\])?(?:[\w.-]+[/\\])*[\w.-]+\.[a-zA-Z][a-zA-Z0-9]{0,9})/;

/**
 * Folder path pattern - matches paths ending with / like docs/, src/components/
 * Must have at least one word character before the trailing slash.
 */
const FOLDER_PATH_PATTERN = /((?:\.\.?\/)?(?:[\w.-]+\/)+)/;

/** Cache for resolved relative paths: key = "sessionId:relativePath" */
const resolveCache = new Map<string, { response: FileResolveResponse; expires: number }>();

/** Cache TTL for resolve results (ms) */
const RESOLVE_CACHE_TTL = 10000;

/** Hover delay before resolving relative paths (ms) - prevents spam during mouse movement */
const RESOLVE_HOVER_DELAY_MS = 150;

/** Pending resolve request - only one at a time, new hovers cancel previous */
let pendingResolve: {
  abort: AbortController;
  timeout: number;
} | null = null;

// ===========================================================================
// Toast Notification
// ===========================================================================

function showFileNotFoundToast(path: string): void {
  const existing = document.querySelector('.drop-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'drop-toast error';
  toast.textContent = `File not found: ${path}`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

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
  if (!isFileRadarEnabled()) {
    return;
  }

  // Decode if needed (reuse decoder to avoid allocation)
  const text = typeof data === 'string' ? data : textDecoder.decode(data);

  // Skip tiny frames (likely cursor moves, not real content)
  if (text.length < MIN_SCAN_FRAME_SIZE) return;

  // Quick check: does this text even contain path-like characters?
  // This avoids regex overhead for frames that are clearly not paths
  if (!QUICK_PATH_CHECK_UNIX.test(text) && !QUICK_PATH_CHECK_WIN.test(text)) {
    return;
  }

  // Append to pending text for this session
  const existing = pendingScanText.get(sessionId) || '';
  pendingScanText.set(sessionId, existing + text);

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
 * Registers detected paths with backend for security allowlisting.
 */
function performScan(sessionId: string, text: string): void {
  // Strip ANSI escape sequences before regex matching
  /* eslint-disable no-control-regex */
  const cleanText = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\][^\x07]*/g, ''); // Incomplete OSC
  /* eslint-enable no-control-regex */

  const allowlist = getPathAllowlist(sessionId);
  const detectedPaths: string[] = [];

  // Reset regex lastIndex and scan for Unix paths
  UNIX_PATH_PATTERN_GLOBAL.lastIndex = 0;
  for (const match of cleanText.matchAll(UNIX_PATH_PATTERN_GLOBAL)) {
    const path = match[1];
    if (!path) continue;
    if (isValidPath(path)) {
      addToAllowlist(allowlist, path);
      detectedPaths.push(path);
    }
  }

  // Reset regex lastIndex and scan for Windows paths
  WIN_PATH_PATTERN_GLOBAL.lastIndex = 0;
  for (const match of cleanText.matchAll(WIN_PATH_PATTERN_GLOBAL)) {
    const path = match[1];
    if (!path) continue;
    if (isValidPath(path)) {
      addToAllowlist(allowlist, path);
      detectedPaths.push(path);
    }
  }

  // Register detected paths with backend for security allowlisting
  if (detectedPaths.length > 0) {
    registerPathsWithBackend(sessionId, detectedPaths);
  }
}

/**
 * Register detected file paths with the backend for security allowlisting.
 * Fire-and-forget - we don't block on this request.
 */
function registerPathsWithBackend(sessionId: string, paths: string[]): void {
  fetch('/api/files/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, paths }),
  }).catch((e) => {
    log.warn(() => `Failed to register paths: ${e}`);
  });
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
    const sessionId = $activeSessionId.get();
    const url = sessionId
      ? `/api/files/check?sessionId=${encodeURIComponent(sessionId)}`
      : '/api/files/check';
    const resp = await fetch(url, {
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
// Relative Path Resolution (lazy, on hover only, throttled)
// ===========================================================================

/**
 * Resolve a relative path against the session's working directory.
 * @param deep - If true, search subdirectories when exact path not found (expensive, for click only)
 */
async function resolveRelativePath(
  sessionId: string,
  relativePath: string,
  deep: boolean = false,
  signal?: AbortSignal,
): Promise<FileResolveResponse | null> {
  const cacheKey = `${sessionId}:${relativePath}:${deep}`;
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.response;
  }

  try {
    const url =
      `/api/files/resolve?sessionId=${encodeURIComponent(sessionId)}` +
      `&path=${encodeURIComponent(relativePath)}` +
      (deep ? '&deep=true' : '');
    const fetchOptions: RequestInit = {};
    if (signal) fetchOptions.signal = signal;
    const resp = await fetch(url, fetchOptions);

    if (!resp.ok) {
      const notFound: FileResolveResponse = { exists: false };
      resolveCache.set(cacheKey, { response: notFound, expires: Date.now() + RESOLVE_CACHE_TTL });
      return notFound;
    }

    const data: FileResolveResponse = await resp.json();
    resolveCache.set(cacheKey, { response: data, expires: Date.now() + RESOLVE_CACHE_TTL });
    return data;
  } catch (e) {
    // AbortError is expected when hover moves away
    if (e instanceof Error && e.name === 'AbortError') {
      return null;
    }
    log.error(() => `Failed to resolve relative path: ${e}`);
    return null;
  }
}

/**
 * Throttled resolve - waits for hover to "settle" before making API call.
 * New hovers cancel pending requests, preventing spam during rapid mouse movement.
 */
function throttledResolveRelativePath(
  sessionId: string,
  path: string,
  matchText: string,
  callback: (match: string | undefined) => void,
): void {
  // Cancel any pending resolve
  if (pendingResolve) {
    pendingResolve.abort.abort();
    window.clearTimeout(pendingResolve.timeout);
    pendingResolve = null;
  }

  // Check cache - if we already checked this path, show link immediately
  const cacheKey = `${sessionId}:${path}:false`;
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    callback(matchText); // Always show link - deep search on click may find it
    return;
  }

  // Schedule delayed resolve to warm cache, but always show link
  // Deep search on click will find files in subdirectories
  const abort = new AbortController();
  const timeout = window.setTimeout(async () => {
    if (abort.signal.aborted) return;

    // Warm cache with shallow search (result ignored for link display)
    await resolveRelativePath(sessionId, path, false, abort.signal);
    if (abort.signal.aborted) return;

    // Always show link - regex already validated file extension
    callback(matchText);

    if (pendingResolve?.abort === abort) {
      pendingResolve = null;
    }
  }, RESOLVE_HOVER_DELAY_MS);

  pendingResolve = { abort, timeout };
}

// ===========================================================================
// Click Handlers
// ===========================================================================

async function handlePathClick(path: string): Promise<void> {
  // Register clicked path with backend allowlist (fire-and-forget)
  const sessionId = $activeSessionId.get();
  if (sessionId) {
    registerPathsWithBackend(sessionId, [path]);
  }

  const info = await checkPathExists(path);
  if (info?.exists) {
    openFile(path, info);
    return;
  }

  // Fallback: Unix-style paths on Windows (e.g., /foo/bar.cs) aren't truly absolute
  // Try resolving as relative path with deep search
  if (sessionId) {
    // Strip leading slash for relative resolution
    const relativePath = path.startsWith('/') ? path.slice(1) : path;
    const resolved = await resolveRelativePath(sessionId, relativePath, true);
    if (resolved?.exists && resolved.resolvedPath) {
      const resolvedInfo: FilePathInfo = {
        exists: true,
        isDirectory: resolved.isDirectory ?? false,
      };
      if (resolved.size !== undefined) resolvedInfo.size = resolved.size;
      if (resolved.mimeType !== undefined) resolvedInfo.mimeType = resolved.mimeType;
      if (resolved.modified !== undefined) resolvedInfo.modified = resolved.modified;
      if (resolved.isText !== undefined) resolvedInfo.isText = resolved.isText;
      openFile(resolved.resolvedPath, resolvedInfo);
      return;
    }
  }

  showFileNotFoundToast(path);
}

async function handleRelativePathClick(relativePath: string): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    showFileNotFoundToast(relativePath);
    return;
  }

  // Use deep=true for click - search subdirectories if exact path not found
  const resolved = await resolveRelativePath(sessionId, relativePath, true);
  if (resolved?.exists && resolved.resolvedPath) {
    // Register resolved path with backend allowlist (fire-and-forget)
    registerPathsWithBackend(sessionId, [resolved.resolvedPath]);

    const info: FilePathInfo = {
      exists: true,
      isDirectory: resolved.isDirectory ?? false,
    };
    if (resolved.size !== undefined) info.size = resolved.size;
    if (resolved.mimeType !== undefined) info.mimeType = resolved.mimeType;
    if (resolved.modified !== undefined) info.modified = resolved.modified;
    if (resolved.isText !== undefined) info.isText = resolved.isText;
    openFile(resolved.resolvedPath, info);
  } else {
    showFileNotFoundToast(relativePath);
  }
}

async function handleFolderPathClick(folderPath: string): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    showFileNotFoundToast(folderPath);
    return;
  }

  // Remove trailing slash for resolution
  const pathWithoutSlash = folderPath.replace(/\/+$/, '');

  // Try to resolve the folder path
  const resolved = await resolveRelativePath(sessionId, pathWithoutSlash, true);
  if (resolved?.exists && resolved.resolvedPath && resolved.isDirectory) {
    const info: FilePathInfo = {
      exists: true,
      isDirectory: true,
    };
    openFile(resolved.resolvedPath, info);
  } else {
    showFileNotFoundToast(folderPath);
  }
}

// ===========================================================================
// Link Provider Registration
// ===========================================================================

/**
 * Register the file link provider with xterm.js using xterm-link-provider.
 * This is called once per terminal session.
 */
export function registerFileLinkProvider(terminal: Terminal, sessionId: string): void {
  if (!isFileRadarEnabled()) return;

  // Cast to 'any' because xterm-link-provider was built for xterm 4.x
  // but we use @xterm/xterm 5+. The APIs are compatible at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const term = terminal as any;

  // Unix paths
  terminal.registerLinkProvider(
    new LinkProvider(term, UNIX_PATH_PATTERN, async (_event, path) => {
      await handlePathClick(path);
    }),
  );

  // Windows paths
  terminal.registerLinkProvider(
    new LinkProvider(term, WIN_PATH_PATTERN, async (_event, path) => {
      await handlePathClick(path);
    }),
  );

  // Relative paths (lazy resolution on hover)
  // The matchCallback option validates paths on hover before showing as clickable
  terminal.registerLinkProvider(
    new LinkProvider(
      term,
      RELATIVE_PATH_PATTERN,
      async (_event, relativePath) => {
        await handleRelativePathClick(relativePath);
      },
      {
        // Validate on hover - only create link if file exists
        // Uses throttled resolution to prevent API spam during rapid mouse movement
        matchCallback: (match: RegExpMatchArray, callback: (match: string | undefined) => void) => {
          const path = match[1];
          if (!path) {
            callback(undefined);
            return;
          }

          // Skip if it looks like an absolute path (already handled above)
          if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
            callback(undefined);
            return;
          }

          // Skip common false positives
          if (isLikelyFalsePositive(path)) {
            callback(undefined);
            return;
          }

          // Throttled resolution: waits 150ms for hover to settle before API call
          throttledResolveRelativePath(sessionId, path, match[0], callback);
        },
      } as unknown as Record<string, unknown>,
    ),
  );

  // Folder paths (e.g., docs/, src/components/)
  terminal.registerLinkProvider(
    new LinkProvider(
      term,
      FOLDER_PATH_PATTERN,
      async (_event, folderPath) => {
        await handleFolderPathClick(folderPath);
      },
      {
        matchCallback: (match: RegExpMatchArray, callback: (match: string | undefined) => void) => {
          const path = match[1];
          if (!path) {
            callback(undefined);
            return;
          }

          // Skip absolute paths (already handled above)
          if (/^[A-Za-z]:/.test(path)) {
            callback(undefined);
            return;
          }

          // Skip common false positives like http://, https://, file://
          if (/^[a-z]+:\/\//i.test(path)) {
            callback(undefined);
            return;
          }

          // Throttled resolution for folders
          throttledResolveRelativePath(sessionId, path.replace(/\/+$/, ''), match[0], callback);
        },
      } as unknown as Record<string, unknown>,
    ),
  );

  log.verbose(() => `Registered file link provider`);
}

/**
 * Filter out common false positives that look like files but aren't.
 */
function isLikelyFalsePositive(path: string): boolean {
  // Version numbers like 1.2.3
  if (/^\d+\.\d+(\.\d+)?$/.test(path)) return true;

  // Common abbreviations
  const lower = path.toLowerCase();
  if (['e.g.', 'i.e.', 'etc.', 'vs.', 'inc.', 'ltd.', 'co.'].includes(lower)) return true;

  // Domain-like patterns - but only if the "TLD" is actually a common TLD, not a file extension
  // This prevents filtering out output.pdf, data.csv, etc.
  if (/^[a-z]+\.[a-z]{2,}$/i.test(path)) {
    const ext = path.split('.').pop()?.toLowerCase();
    const commonTlds = ['com', 'org', 'net', 'io', 'co', 'dev', 'app', 'ai', 'edu', 'gov', 'me'];
    if (ext && commonTlds.includes(ext)) return true;
  }

  return false;
}

// Legacy export for compatibility (unused but keeps API stable)
export function createFileLinkProvider(_sessionId: string): null {
  return null;
}
