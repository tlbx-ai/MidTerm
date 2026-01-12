/**
 * Log Storage Module
 *
 * IndexedDB-based storage for frontend logs with automatic
 * cleanup of old entries.
 */

import type { LogEntry } from './types';
import { type LogLevel } from './types';

const DB_NAME = 'midterm-logs';
const DB_VERSION = 1;
const STORE_NAME = 'logs';
const MAX_ENTRIES = 10000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let db: IDBDatabase | null = null;
let initPromise: Promise<IDBDatabase> | null = null;

/**
 * Initialize the IndexedDB database
 */
function initDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[LogStorage] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });

        store.createIndex('by-timestamp', 'timestamp', { unique: false });
        store.createIndex('by-level', 'level', { unique: false });
        store.createIndex('by-module', 'module', { unique: false });
      }
    };
  });

  return initPromise;
}

/**
 * Write a log entry to storage
 */
export async function writeLogEntry(entry: Omit<LogEntry, 'id'>): Promise<void> {
  try {
    const database = await initDb();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.add(entry);
  } catch (_error) {
    // Silent fail - logging should never break the app
  }
}

/**
 * Read log entries with optional filtering
 */
export async function readLogEntries(options?: {
  minLevel?: LogLevel;
  module?: string;
  limit?: number;
  offset?: number;
}): Promise<LogEntry[]> {
  const database = await initDb();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const index = store.index('by-timestamp');

  return new Promise((resolve, reject) => {
    const entries: LogEntry[] = [];
    const limit = options?.limit ?? 1000;
    let skipped = 0;
    const offset = options?.offset ?? 0;

    const request = index.openCursor(null, 'prev'); // newest first

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length >= limit) {
        resolve(entries);
        return;
      }

      const entry = cursor.value as LogEntry;

      // Apply filters
      if (options?.minLevel !== undefined && entry.level > options.minLevel) {
        cursor.continue();
        return;
      }
      if (options?.module && entry.module !== options.module) {
        cursor.continue();
        return;
      }

      // Apply offset
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }

      entries.push(entry);
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all log entries
 */
export async function clearLogs(): Promise<void> {
  const database = await initDb();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.clear();
}

/**
 * Get total log entry count
 */
export async function getLogCount(): Promise<number> {
  const database = await initDb();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clean up old entries to enforce limits
 */
export async function cleanupOldEntries(): Promise<number> {
  const database = await initDb();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const index = store.index('by-timestamp');

  return new Promise((resolve) => {
    let deleted = 0;
    const cutoff = Date.now() - MAX_AGE_MS;
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      const excessCount = Math.max(0, count - MAX_ENTRIES);

      // Delete old entries (by age)
      const ageRequest = index.openCursor(IDBKeyRange.upperBound(cutoff));
      ageRequest.onsuccess = () => {
        const cursor = ageRequest.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };

      // Delete excess entries (by count) - oldest first
      if (excessCount > 0) {
        let excessDeleted = 0;
        const excessRequest = index.openCursor();
        excessRequest.onsuccess = () => {
          const cursor = excessRequest.result;
          if (cursor && excessDeleted < excessCount) {
            cursor.delete();
            deleted++;
            excessDeleted++;
            cursor.continue();
          } else {
            resolve(deleted);
          }
        };
      } else {
        resolve(deleted);
      }
    };
  });
}

/**
 * Initialize storage and schedule cleanup
 */
export async function initLogStorage(): Promise<void> {
  await initDb();
  // Run cleanup on init
  await cleanupOldEntries();
  // Schedule periodic cleanup (every 5 minutes)
  setInterval(() => cleanupOldEntries(), 5 * 60 * 1000);
}
