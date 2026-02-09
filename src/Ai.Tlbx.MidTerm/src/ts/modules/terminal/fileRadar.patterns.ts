/**
 * File Radar Patterns Module
 *
 * Pure regex patterns and validation logic for detecting file paths in terminal output.
 * Extracted for testability — no DOM, fetch, or xterm dependencies.
 */

// ===========================================================================
// Regex Patterns - Compiled once at module load
// ===========================================================================

/**
 * Unix absolute paths: /path/to/file or /path/to/file.ext
 * Negative lookbehind prevents matching /foo/bar inside src/foo/bar (relative paths)
 */
export const UNIX_PATH_PATTERN = /(?<![a-zA-Z0-9_.@-])(\/(?:[\w.@-]+\/)*[\w.@-]+(?:\.\w+)?)/;

/**
 * Windows absolute paths: C:\path\file or C:/path/file
 */
export const WIN_PATH_PATTERN = /([A-Za-z]:[\\/](?:[\w.@-]+[\\/])*[\w.@-]+(?:\.\w+)?)/;

/**
 * Global versions for scanning terminal output (anchored with whitespace/quotes)
 */
export const UNIX_PATH_PATTERN_GLOBAL =
  /(?:^|[\s"'`(])(\/([\w.@-]+\/)*[\w.@-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;
export const WIN_PATH_PATTERN_GLOBAL =
  /(?:^|[\s"'`(])([A-Za-z]:[\\/](?:[\w.@-]+[\\/])*[\w.@-]+(?:\.\w+)?)(?=[\s"'`)]|$)/g;

/**
 * Relative path pattern - matches any filename.extension pattern.
 * Extension: 1-10 chars, must start with letter.
 * Supports both / and \ path separators.
 */
export const RELATIVE_PATH_PATTERN =
  /((?:\.\.?[/\\])?(?:[\w.@-]+[/\\])*[\w.@-]+\.[a-zA-Z][a-zA-Z0-9]{0,9})/;

/**
 * Folder path pattern - matches paths ending with / or \
 */
export const FOLDER_PATH_PATTERN = /((?:\.\.?[/\\])?(?:[\w.@-]+[/\\])+)/;

/**
 * Well-known files without extensions.
 */
export const KNOWN_EXTENSIONLESS_LIST = [
  'Dockerfile',
  'Makefile',
  'Vagrantfile',
  'Gemfile',
  'Rakefile',
  'Procfile',
  'Justfile',
  'Taskfile',
  'Brewfile',
  'Podfile',
  'Fastfile',
  'Appfile',
  'LICENSE',
  'LICENCE',
  'CHANGELOG',
  'README',
  'CONTRIBUTING',
  'AUTHORS',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.dockerignore',
  '.eslintignore',
  '.prettierignore',
  '.npmignore',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.browserslistrc',
];

const KNOWN_FILE_NAMES_ALTERNATION = [...KNOWN_EXTENSIONLESS_LIST]
  .sort((a, b) => b.length - a.length)
  .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * Pattern for extensionless known files - only matches exact known filenames,
 * optionally preceded by a directory path (e.g., src/Dockerfile).
 */
export const KNOWN_FILE_PATTERN = new RegExp(
  `((?:[\\w.@-]+[/\\\\])*(?:${KNOWN_FILE_NAMES_ALTERNATION}))`,
);

// ===========================================================================
// Validation Functions
// ===========================================================================

export function isValidPath(path: string): boolean {
  if (!path || path.length < 2) return false;
  if (path.includes('..')) return false;
  if (/^\/[a-z]+$/.test(path)) return false;
  return true;
}

/**
 * Filter out common false positives that look like files but aren't.
 */
export function isLikelyFalsePositive(path: string): boolean {
  if (/^\d+\.\d+(\.\d+)?$/.test(path)) return true;

  const lower = path.toLowerCase();
  if (['e.g.', 'i.e.', 'etc.', 'vs.', 'inc.', 'ltd.', 'co.'].includes(lower)) return true;

  if (/^[a-z]+\.[a-z]{2,}$/i.test(path)) {
    const ext = path.split('.').pop()?.toLowerCase();
    const commonTlds = ['com', 'org', 'net', 'io', 'co', 'dev', 'app', 'ai', 'edu', 'gov', 'me'];
    if (ext && commonTlds.includes(ext)) return true;
  }

  if (!path.includes('/') && !path.includes('\\')) {
    const dotCount = path.split('.').length - 1;
    // .NET fully-qualified names: Namespace.Namespace.Class.Method — 4+ dots without
    // path separators is almost certainly a FQN, not a file
    if (dotCount >= 4) return true;
    // PascalCase "extension" (5+ chars starting uppercase) without path separators —
    // catches method calls (Results.Forbid), project names (Ai.Tlbx.MidTerm)
    if (dotCount >= 1) {
      const ext = path.split('.').pop();
      if (ext && ext.length >= 5 && /^[A-Z]/.test(ext)) return true;
    }
  }

  return false;
}

// ===========================================================================
// matchCallback Filter Predicates
// ===========================================================================

export function isFragmentOfAbsolutePath(match: { input?: string; index?: number }): boolean {
  if (!match.input || match.index === undefined || match.index < 3) return false;
  const before = match.input.substring(match.index - 3, match.index);
  return /^[A-Za-z]:[/\\]$/.test(before);
}

export function shouldRejectFolderMatch(path: string): boolean {
  if (/^[A-Za-z]:/.test(path)) return true;
  if (/^[a-z]+:\/\//i.test(path)) return true;
  return false;
}

export function shouldRejectKnownFileMatch(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:/.test(path);
}

export function shouldRejectRelativeMatch(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true;
  return isLikelyFalsePositive(path);
}
