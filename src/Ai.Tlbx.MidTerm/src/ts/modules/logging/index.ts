/**
 * Logging Module
 *
 * Provides lazy-evaluated logging with console output.
 * Errors and warnings are always logged to console.
 */

export { LogLevel, LOG_LEVEL_NAMES } from './types';
export type { LogEntry, Logger } from './types';

export { createLogger, setLogLevel, getLogLevel, setConsoleLogging } from './logger';
