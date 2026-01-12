/**
 * Command History Module
 *
 * Tracks (shell type, subprocess, working directory) combinations
 * with frequency weighting to recreate terminal setups.
 */

import { createLogger } from '../logging';

const log = createLogger('history');

const STORAGE_KEY = 'midterm-command-history';
const MAX_ENTRIES = 100;
const PRUNE_AGE_DAYS = 30;

export interface CommandHistoryEntry {
  id: string;
  shellType: string;
  subprocess: string | null;
  workingDirectory: string;
  weight: number;
  lastUsed: number;
  displayName?: string;
}

let entries: CommandHistoryEntry[] = [];
let onHistoryChanged: (() => void) | null = null;

/**
 * Initialize command history from storage.
 */
export function initializeCommandHistory(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      entries = JSON.parse(stored);
      pruneOldEntries();
    }
  } catch (e) {
    log.warn(() => `Failed to load command history: ${e}`);
    entries = [];
  }
}

/**
 * Register callback for history changes.
 */
export function registerHistoryCallback(callback: () => void): void {
  onHistoryChanged = callback;
}

/**
 * Record a command execution.
 */
export function recordCommand(
  shellType: string,
  subprocess: string | null,
  workingDirectory: string,
): void {
  const key = generateKey(shellType, subprocess, workingDirectory);

  const existing = entries.find((e) => e.id === key);
  if (existing) {
    existing.weight++;
    existing.lastUsed = Date.now();
  } else {
    const entry: CommandHistoryEntry = {
      id: key,
      shellType,
      subprocess,
      workingDirectory,
      weight: 1,
      lastUsed: Date.now(),
    };
    entries.push(entry);
  }

  pruneExcessEntries();
  saveHistory();
  notifyChange();

  log.verbose(() => `Recorded: ${shellType} + ${subprocess || 'shell'} in ${workingDirectory}`);
}

/**
 * Get sorted history entries (most frequently used first).
 */
export function getHistoryEntries(): CommandHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
    }
    return b.lastUsed - a.lastUsed;
  });
}

/**
 * Clear all history.
 */
export function clearHistory(): void {
  entries = [];
  saveHistory();
  notifyChange();
}

/**
 * Remove a specific entry.
 */
export function removeEntry(id: string): void {
  entries = entries.filter((e) => e.id !== id);
  saveHistory();
  notifyChange();
}

/**
 * Update display name for an entry.
 */
export function setDisplayName(id: string, name: string | undefined): void {
  const entry = entries.find((e) => e.id === id);
  if (entry) {
    if (name === undefined) {
      delete entry.displayName;
    } else {
      entry.displayName = name;
    }
    saveHistory();
  }
}

/**
 * Get display text for an entry.
 */
export function getEntryDisplayText(entry: CommandHistoryEntry): string {
  if (entry.displayName) {
    return entry.displayName;
  }

  const parts = [entry.shellType];
  if (entry.subprocess) {
    parts.push(entry.subprocess);
  }
  parts.push(shortenPath(entry.workingDirectory));

  return parts.join(' \u2192 ');
}

function generateKey(
  shellType: string,
  subprocess: string | null,
  workingDirectory: string,
): string {
  const normalized = workingDirectory.toLowerCase().replace(/\\/g, '/');
  return `${shellType}|${subprocess || ''}|${normalized}`;
}

function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) {
    return path;
  }

  const first = parts[0];
  const second = parts[1];

  if (first === '' && second === 'home') {
    return '~/' + parts.slice(3).join('/');
  }

  if (first && /^[A-Z]:$/i.test(first)) {
    if (parts.length > 3) {
      return first + '/.../' + parts.slice(-2).join('/');
    }
  }

  return parts.slice(-2).join('/');
}

function pruneOldEntries(): void {
  const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;
  entries = entries.filter((e) => e.weight > 2 || e.lastUsed > cutoff);
}

function pruneExcessEntries(): void {
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => {
      if (b.weight !== a.weight) {
        return b.weight - a.weight;
      }
      return b.lastUsed - a.lastUsed;
    });
    entries = entries.slice(0, MAX_ENTRIES);
  }
}

function saveHistory(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    log.warn(() => `Failed to save command history: ${e}`);
  }
}

function notifyChange(): void {
  if (onHistoryChanged) {
    onHistoryChanged();
  }
}
