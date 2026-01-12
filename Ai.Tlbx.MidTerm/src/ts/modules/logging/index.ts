/**
 * Logging Module
 *
 * Provides lazy-evaluated logging with IndexedDB persistence.
 * Logs are stored locally and accessible via the Diagnostics panel.
 */

export { LogLevel, LOG_LEVEL_NAMES } from './types';
export type { LogEntry, Logger } from './types';

export { createLogger, setLogLevel, getLogLevel, setConsoleLogging } from './logger';

export {
  initLogStorage,
  readLogEntries,
  clearLogs,
  getLogCount,
  cleanupOldEntries,
} from './storage';
