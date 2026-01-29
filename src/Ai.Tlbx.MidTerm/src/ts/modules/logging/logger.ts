/**
 * Logger Module
 *
 * Provides lazy-evaluated logging with console output.
 * The messageFactory lambda is only called if the log level is enabled,
 * avoiding string allocation overhead for disabled levels.
 *
 * Errors and warnings are always logged to console regardless of settings.
 * Info and verbose only log when the module's concern is enabled via mtlog.enable().
 */

import type { Logger, LogEntry } from './types';
import { LogLevel, LOG_LEVEL_NAMES } from './types';
import { isConcernEnabled, getMinLevel } from './concerns';

function formatConsoleMessage(entry: Omit<LogEntry, 'id'>): string {
  const date = new Date(entry.timestamp);
  const time = date.toISOString().slice(11, 23);
  return `[${time}] [${LOG_LEVEL_NAMES[entry.level]}] [${entry.module}] ${entry.message}`;
}

function writeLog(level: LogLevel, module: string, message: string, data?: unknown): void {
  const entry: Omit<LogEntry, 'id'> = {
    timestamp: Date.now(),
    level,
    module,
    message,
    data,
  };

  const formatted = formatConsoleMessage(entry);

  if (level <= LogLevel.Error) {
    console.error(formatted, data ?? '');
    return;
  }

  if (level === LogLevel.Warn) {
    console.warn(formatted, data ?? '');
    return;
  }

  if (isConcernEnabled(module)) {
    switch (level) {
      case LogLevel.Info:
        console.info(formatted, data ?? '');
        break;
      case LogLevel.Verbose:
        console.debug(formatted, data ?? '');
        break;
    }
  }
}

export function createLogger(module: string): Logger {
  return {
    exception(error: Error, context?: string): void {
      const message = context ? `${context}: ${error.message}` : error.message;
      writeLog(LogLevel.Exception, module, message, {
        name: error.name,
        stack: error.stack,
      });
    },

    error(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Error > getMinLevel()) return;
      writeLog(LogLevel.Error, module, messageFactory(), data);
    },

    warn(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Warn > getMinLevel()) return;
      writeLog(LogLevel.Warn, module, messageFactory(), data);
    },

    info(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Info > getMinLevel()) return;
      if (!isConcernEnabled(module)) return;
      writeLog(LogLevel.Info, module, messageFactory(), data);
    },

    verbose(messageFactory: () => string, data?: unknown): void {
      if (LogLevel.Verbose > getMinLevel()) return;
      if (!isConcernEnabled(module)) return;
      writeLog(LogLevel.Verbose, module, messageFactory(), data);
    },

    log(level: LogLevel, messageFactory: () => string, data?: unknown): void {
      if (level > getMinLevel()) return;
      if (level > LogLevel.Warn && !isConcernEnabled(module)) return;
      writeLog(level, module, messageFactory(), data);
    },
  };
}
