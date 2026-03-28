export interface TerminalKeyLogEntry {
  timestampMs: number;
  sessionId: string;
  source: string;
  type: string;
  key?: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target?: string;
  note?: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

export type TerminalKeyLogEntryInput = Omit<TerminalKeyLogEntry, 'timestampMs'>;

const STORAGE_KEY = 'diagnostics-terminal-key-log-enabled';
const MAX_ENTRIES = 80;

const entries: TerminalKeyLogEntry[] = [];
const listeners = new Set<() => void>();

let enabledCache: boolean | null = null;

function notifyListeners(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

function loadEnabledState(): boolean {
  if (enabledCache !== null) {
    return enabledCache;
  }

  try {
    enabledCache = localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    enabledCache = false;
  }

  return enabledCache;
}

function persistEnabledState(enabled: boolean): void {
  enabledCache = enabled;
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in diagnostics helpers.
  }
}

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatModifierFlags(
  entry: Pick<TerminalKeyLogEntry, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): string {
  const parts: string[] = [];
  if (entry.ctrlKey) parts.push('C');
  if (entry.shiftKey) parts.push('S');
  if (entry.altKey) parts.push('A');
  if (entry.metaKey) parts.push('M');
  return parts.length > 0 ? parts.join('-') : '-';
}

function formatEntry(entry: TerminalKeyLogEntry): string {
  const parts = [
    `[${formatTimestamp(entry.timestampMs)}]`,
    `s=${entry.sessionId}`,
    entry.source,
    entry.type,
    `key=${entry.key ?? '-'}`,
    `code=${entry.code ?? '-'}`,
    `mods=${formatModifierFlags(entry)}`,
  ];

  if (entry.target) {
    parts.push(`target=${entry.target}`);
  }
  if (entry.defaultPrevented) {
    parts.push('prevented');
  }
  if (entry.isComposing) {
    parts.push('composing');
  }
  if (entry.note) {
    parts.push(entry.note);
  }

  return parts.join(' ');
}

export function isTerminalKeyLogEnabled(): boolean {
  return loadEnabledState();
}

export function setTerminalKeyLogEnabled(enabled: boolean): void {
  persistEnabledState(enabled);
  notifyListeners();
}

export function clearTerminalKeyLog(): void {
  entries.length = 0;
  notifyListeners();
}

export function recordTerminalKeyLog(entry: TerminalKeyLogEntryInput): void {
  if (!loadEnabledState()) {
    return;
  }

  entries.push({
    ...entry,
    timestampMs: Date.now(),
  });

  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  notifyListeners();
}

export function getTerminalKeyLogLines(): string[] {
  if (!loadEnabledState()) {
    return ['Enable terminal key log to capture Enter and modifier events.'];
  }

  if (entries.length === 0) {
    return ['No terminal key events captured yet.'];
  }

  return entries.map(formatEntry);
}

export function subscribeTerminalKeyLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
