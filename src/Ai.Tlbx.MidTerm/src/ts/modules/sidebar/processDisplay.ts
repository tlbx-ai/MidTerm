/**
 * Process Display Module
 *
 * Smart display formatting for runtime wrapper processes (node, python, etc.).
 * Extracts meaningful tool names from verbose command lines for sidebar and history display.
 */

const RUNTIME_NAMES = new Set(['node', 'python', 'python3', 'ruby', 'java', 'deno', 'bun']);

const GENERIC_SCRIPT_NAMES = new Set([
  'main.js',
  'index.js',
  'cli.js',
  'main.ts',
  'index.ts',
  'cli.ts',
  'main.py',
  'index.py',
  'cli.py',
  '__main__.py',
  'main.rb',
  'index.rb',
  'cli.rb',
]);

const SKIP_PARENT_DIRS = new Set(['bin', 'src', 'lib', 'dist', 'build', 'scripts']);

/**
 * Format a process display name, with smart handling for runtime wrapper processes.
 * For `node .../node_modules/@openai/codex/bin/codex.js ...` → `codex ...`
 * For native processes, falls back to stripExePath behavior.
 */
export function formatRuntimeDisplay(processName: string, commandLine: string | null): string {
  const raw = commandLine ?? processName;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const runtimeName = extractRuntimeName(processName);
  if (!runtimeName) return stripExePath(trimmed);

  const tokens = tokenizeCommandLine(trimmed);
  if (tokens.length === 0) return stripExePath(trimmed);

  let idx = 0;

  // Skip the runtime exe token if present (Windows includes it, Linux/Mac don't)
  if (isRuntimeToken(tokens[0] ?? '')) {
    idx++;
  }

  if (idx >= tokens.length) return runtimeName;

  const current = tokens[idx] ?? '';

  // Handle python -m <module>
  if (runtimeName.startsWith('python') && current === '-m' && idx + 1 < tokens.length) {
    const mod = tokens[idx + 1] ?? '';
    const rest = filterDisplayArgs(tokens.slice(idx + 2));
    return rest ? `${mod} ${rest}` : mod;
  }

  // Handle -e / -c (inline script)
  if (current === '-e' || current === '-c') {
    return `${runtimeName} ${current} ...`;
  }

  // Skip flags until we find the script path
  while (idx < tokens.length && (tokens[idx] ?? '').startsWith('-')) {
    idx++;
  }

  if (idx >= tokens.length) {
    const startIdx = isRuntimeToken(tokens[0] ?? '') ? 1 : 0;
    const flags = filterDisplayArgs(tokens.slice(startIdx));
    return flags ? `${runtimeName} ${flags}` : runtimeName;
  }

  const scriptPath = tokens[idx] ?? '';
  const displayName = extractScriptDisplayName(scriptPath);
  const rest = filterDisplayArgs(tokens.slice(idx + 1));
  return rest ? `${displayName} ${rest}` : displayName;
}

/**
 * Strip executable path from command line, keeping just the exe name and arguments.
 * Handles quoted paths and unquoted paths. Strips .exe extension.
 */
export function stripExePath(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote > 1) {
      const quotedPath = trimmed.slice(1, endQuote);
      const rest = trimmed.slice(endQuote + 1);
      const exeName = basename(quotedPath).replace(/\.exe$/i, '');
      return (exeName + rest).trim();
    }
  }

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return basename(trimmed).replace(/\.exe$/i, '');
  }

  const exePart = trimmed.slice(0, spaceIdx);
  const argsPart = trimmed.slice(spaceIdx);
  const exeName = basename(exePart).replace(/\.exe$/i, '');
  return (exeName + argsPart).trim();
}

/**
 * Build a complete replay command from executable + commandLine.
 * On Linux/Mac, commandLine may not include the runtime name — prepend it if needed.
 */
export function buildReplayCommand(executable: string, commandLine: string): string {
  if (!executable || !commandLine) return commandLine || executable || '';

  const cmdNorm = commandLine.replace(/\\/g, '/').toLowerCase();
  const exeNorm = executable
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/\.exe$/i, '');

  const firstToken = (cmdNorm.split(/\s/)[0] ?? '').replace(/\.exe$/i, '');
  const firstTokenBase = basename(firstToken);
  const exeBase = basename(exeNorm);

  if (firstTokenBase === exeBase) return commandLine;

  return `${executable} ${commandLine}`;
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function extractRuntimeName(processName: string): string | null {
  const name = basename(processName)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  return RUNTIME_NAMES.has(name) ? name : null;
}

function isRuntimeToken(token: string): boolean {
  const name = basename(token)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  return RUNTIME_NAMES.has(name);
}

function tokenizeCommandLine(cmdLine: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = cmdLine.length;

  while (i < len) {
    while (i < len && cmdLine[i] === ' ') i++;
    if (i >= len) break;

    if (cmdLine[i] === '"') {
      const end = cmdLine.indexOf('"', i + 1);
      if (end !== -1) {
        tokens.push(cmdLine.slice(i + 1, end));
        i = end + 1;
      } else {
        tokens.push(cmdLine.slice(i + 1));
        break;
      }
    } else if (cmdLine[i] === "'") {
      const end = cmdLine.indexOf("'", i + 1);
      if (end !== -1) {
        tokens.push(cmdLine.slice(i + 1, end));
        i = end + 1;
      } else {
        tokens.push(cmdLine.slice(i + 1));
        break;
      }
    } else {
      const end = cmdLine.indexOf(' ', i);
      if (end !== -1) {
        tokens.push(cmdLine.slice(i, end));
        i = end;
      } else {
        tokens.push(cmdLine.slice(i));
        break;
      }
    }
  }

  return tokens;
}

function extractScriptDisplayName(scriptPath: string): string {
  const normalized = scriptPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const filename = parts[parts.length - 1] ?? scriptPath;

  // node_modules package detection — use last occurrence for pnpm compatibility
  const lastNmIdx = normalized.lastIndexOf('node_modules/');
  if (lastNmIdx !== -1) {
    const afterNm = normalized.slice(lastNmIdx + 'node_modules/'.length);
    const segments = afterNm.split('/');
    const first = segments[0] ?? '';
    if (first.startsWith('@') && segments.length >= 2) {
      return segments[1] ?? filename;
    }
    return first || filenameWithoutExt(filename);
  }

  // Generic script name → use parent directory
  if (GENERIC_SCRIPT_NAMES.has(filename.toLowerCase())) {
    for (let i = parts.length - 2; i >= 0; i--) {
      const dir = parts[i] ?? '';
      if (!SKIP_PARENT_DIRS.has(dir.toLowerCase())) {
        return dir;
      }
    }
  }

  return filenameWithoutExt(filename);
}

function filenameWithoutExt(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

function filterDisplayArgs(tokens: string[]): string {
  return tokens
    .filter((t) => {
      if (t.startsWith('-')) return true;
      if (t.startsWith('/') || /^[A-Za-z]:[/\\]/.test(t)) return false;
      return true;
    })
    .join(' ');
}
