/**
 * Logging Module
 *
 * Provides lazy-evaluated, concern-based logging with console output.
 * Errors and warnings always log. Info/verbose only log for enabled concerns.
 * Control via browser console: mtlog.enable('mux'), mtlog.list(), etc.
 */

export { LogLevel, LOG_LEVEL_NAMES } from './types';
export type { LogEntry, Logger } from './types';

export { createLogger } from './logger';
export { initLogConcerns } from './concerns';
