/**
 * Logging Types
 *
 * Type definitions for the frontend logging system.
 */

/** Log severity levels (matching backend LogLevel enum) */
export const enum LogLevel {
  Exception = 0,
  Error = 1,
  Warn = 2,
  Info = 3,
  Verbose = 4,
}

/** Log level display names */
export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.Exception]: 'EXCEPTION',
  [LogLevel.Error]: 'ERROR',
  [LogLevel.Warn]: 'WARN',
  [LogLevel.Info]: 'INFO',
  [LogLevel.Verbose]: 'VERBOSE',
};

/** A single log entry */
export interface LogEntry {
  id?: number;
  timestamp: number;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

/** Logger interface */
export interface Logger {
  exception: (error: Error, context?: string) => void;
  error: (messageFactory: () => string, data?: unknown) => void;
  warn: (messageFactory: () => string, data?: unknown) => void;
  info: (messageFactory: () => string, data?: unknown) => void;
  verbose: (messageFactory: () => string, data?: unknown) => void;
  log: (level: LogLevel, messageFactory: () => string, data?: unknown) => void;
}
