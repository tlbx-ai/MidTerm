const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?/;

export function formatHistoryDirectoryDisplay(cwd: string, maxLength = 36): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed.length <= maxLength) {
    return trimmed;
  }

  const separator = trimmed.includes('\\') ? '\\' : '/';
  const { root, segments } = splitPath(trimmed, separator);

  if (segments.length <= 1) {
    return compactMiddle(trimmed, maxLength);
  }

  const prefix = joinPath(root, segments.slice(0, 1), separator);
  const preferredSuffix = segments.slice(-2).join(separator);
  const singleSegmentSuffix = segments[segments.length - 1] ?? '';

  const candidates = [
    buildCompactPath(prefix, preferredSuffix, separator),
    buildCompactPath(prefix, singleSegmentSuffix, separator),
    root ? buildCompactPath(root, singleSegmentSuffix, separator) : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.length <= maxLength) {
      return candidate;
    }
  }

  if (root) {
    const suffixBudget = maxLength - root.length - 2;
    if (suffixBudget > 4) {
      return `${root}…${separator}${compactMiddle(singleSegmentSuffix, suffixBudget)}`;
    }
  }

  return compactMiddle(singleSegmentSuffix, maxLength);
}

function splitPath(path: string, separator: string): { root: string; segments: string[] } {
  const uncMatch = path.match(UNC_ROOT);
  if (uncMatch) {
    const root = ensureTrailingSeparator(uncMatch[0], separator);
    return {
      root,
      segments: path
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean),
    };
  }

  if (WINDOWS_DRIVE_ROOT.test(path)) {
    const root = `${path.slice(0, 2)}${separator}`;
    return {
      root,
      segments: path
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean),
    };
  }

  if (path.startsWith('/')) {
    return {
      root: '/',
      segments: path.slice(1).split('/').filter(Boolean),
    };
  }

  return {
    root: '',
    segments: path.split(/[\\/]+/).filter(Boolean),
  };
}

function joinPath(root: string, segments: string[], separator: string): string {
  if (segments.length === 0) {
    return root;
  }

  const body = segments.join(separator);
  if (!root) {
    return body;
  }

  return root.endsWith(separator) ? `${root}${body}` : `${root}${separator}${body}`;
}

function buildCompactPath(prefix: string, suffix: string, separator: string): string {
  if (!prefix) {
    return `…${separator}${suffix}`;
  }

  return prefix.endsWith(separator)
    ? `${prefix}…${separator}${suffix}`
    : `${prefix}${separator}…${separator}${suffix}`;
}

function ensureTrailingSeparator(path: string, separator: string): string {
  return path.endsWith(separator) ? path : `${path}${separator}`;
}

function compactMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return '…';
  }

  const available = maxLength - 1;
  const head = Math.max(4, Math.ceil(available * 0.45));
  const tail = Math.max(4, available - head);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
