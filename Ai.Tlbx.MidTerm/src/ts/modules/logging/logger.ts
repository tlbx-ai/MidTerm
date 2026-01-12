/**
 * Logger Module
 *
 * Provides lazy-evaluated logging with IndexedDB persistence.
 * The messageFactory lambda is only called if the log level is enabled,
 * avoiding string allocation overhead for disabled levels.
 */

import type { Logger, LogEntry } from './types';
import { LogLevel, LOG_LEVEL_NAMES } from './types';
import { writeLogEntry } from './storage';

/** Current minimum log level (default: Warn) */
let minLevel: LogLevel = LogLevel.Warn;

/** Whether to also log to console (development mode) */
let consoleEnabled = false;

/**
 * Set the minimum log level
 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Get the current minimum log level
 */
export function getLogLevel(): LogLevel {
  return minLevel;
}

/**
 * Enable or disable console logging
 */
export function setConsoleLogging(enabled: boolean): void {
  consoleEnabled = enabled;
}

/**
 * Format a log entry for console output
 */
function formatConsoleMessage(entry: Omit<LogEntry, 'id'>): string {
  const date = new Date(entry.timestamp);
  const time = date.toISOString().slice(11, 23);
  return `[${time}] [${LOG_LEVEL_NAMES[entry.level]}] [${entry.module}] ${entry.message}`;
}

/**
 * Write a log entry (internal)
 */
function writeLog(level: LogLevel, module: string, message: string, data?: unknown): void {
  const entry: Omit<LogEntry, 'id'> = {
    timestamp: Date.now(),
    level,
    module,
    message,
    data,
  };

  // Write to IndexedDB (async, fire-and-forget)
  writeLogEntry(entry);

  // Also log to console if enabled
  if (consoleEnabled) {
    const formatted = formatConsoleMessage(entry);
    switch (level) {
      case LogLevel.Exception:
      case LogLevel.Error:
        console.error(formatted, data ?? '');
        break;
      case LogLevel.Warn:
        console.warn(formatted, data ?? '');
        break;
      case LogLevel.Info:
        console.info(formatted, data ?? '');
        break;
      case LogLevel.Verbose:
        console.debug(formatted, data ?? '');
        break;
    }
  }
}

/**
 * Create a logger instance for a specific module
 */
export function createLogger(module: string): Logger {
  return {
    exception(error: Error, context?: string): void {
      // Exceptions always log regardless of level
      const message = context ? `${context}: ${error.message}` : error.message;
      writeLog(LogLevel.Exception, module, message, {
        name: error.name,
        stack: error.stack,
      });
    },

    error(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Error > minLevel) return;
      writeLog(LogLevel.Error, module, messageFactory(), data);
    },

    warn(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Warn > minLevel) return;
      writeLog(LogLevel.Warn, module, messageFactory(), data);
    },

    info(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Info > minLevel) return;
      writeLog(LogLevel.Info, module, messageFactory(), data);
    },

    verbose(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Verbose > minLevel) return;
      writeLog(LogLevel.Verbose, module, messageFactory(), data);
    },

    log(level: LogLevel, messageFactory: () => string, data?: unknown): void {
      if (level > minLevel) return;
      writeLog(level, module, messageFactory(), data);
    },
  };
}
