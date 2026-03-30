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
const CONSOLE_PREFIX = '[mtkey]';

const entries: TerminalKeyLogEntry[] = [];
const listeners = new Set<() => void>();

let enabledCache: boolean | null = null;
let storageSyncInstalled = false;

function notifyListeners(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

function installStorageSync(): void {
  if (storageSyncInstalled || typeof window === 'undefined') {
    return;
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    enabledCache = event.newValue === 'true';
    notifyListeners();
  });

  storageSyncInstalled = true;
}

function loadEnabledState(): boolean {
  installStorageSync();

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

function logToBrowserConsole(entry: TerminalKeyLogEntry): void {
  // eslint-disable-next-line no-console
  console.info(`${CONSOLE_PREFIX} ${formatEntry(entry)}`);
}

export function isTerminalKeyLogEnabled(): boolean {
  return loadEnabledState();
}

export function setTerminalKeyLogEnabled(enabled: boolean): void {
  persistEnabledState(enabled);
  // eslint-disable-next-line no-console
  console.info(`${CONSOLE_PREFIX} ${enabled ? 'enabled' : 'disabled'}`);
  notifyListeners();
}

export function clearTerminalKeyLog(): void {
  entries.length = 0;
  if (loadEnabledState()) {
    // eslint-disable-next-line no-console
    console.info(`${CONSOLE_PREFIX} cleared`);
  }
  notifyListeners();
}

export function recordTerminalKeyLog(entry: TerminalKeyLogEntryInput): void {
  if (!loadEnabledState()) {
    return;
  }

  const nextEntry: TerminalKeyLogEntry = {
    ...entry,
    timestampMs: Date.now(),
  };

  entries.push(nextEntry);

  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  logToBrowserConsole(nextEntry);
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
