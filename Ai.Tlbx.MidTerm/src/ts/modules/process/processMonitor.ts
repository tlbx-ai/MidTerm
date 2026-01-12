/**
 * Process Monitor Module
 *
 * Manages process state for terminal sessions.
 * Tracks foreground process and subprocess activity for UI display.
 */

import type {
  ProcessState,
  ProcessEventPayload,
  ForegroundChangePayload,
  RacingLogEntry,
} from '../../types';
import { createLogger } from '../logging';
import { recordCommand } from '../history';

const log = createLogger('process');

const MAX_RACING_LOG_ENTRIES = 10;
const RACING_LOG_HIDE_DELAY = 2000;

const processStates = new Map<string, ProcessState>();
const hideTimers = new Map<string, ReturnType<typeof setTimeout>>();

let onProcessStateChanged: ((sessionId: string, state: ProcessState) => void) | null = null;
let getSessionShellType: ((sessionId: string) => string | null) | null = null;

/**
 * Register function to get shell type for a session.
 */
export function registerShellTypeLookup(fn: (sessionId: string) => string | null): void {
  getSessionShellType = fn;
}

/**
 * Register callback for process state changes.
 */
export function registerProcessStateCallback(
  callback: (sessionId: string, state: ProcessState) => void,
): void {
  onProcessStateChanged = callback;
}

/**
 * Get or create process state for a session.
 */
export function getProcessState(sessionId: string): ProcessState {
  let state = processStates.get(sessionId);
  if (!state) {
    state = {
      foregroundPid: null,
      foregroundName: null,
      foregroundCwd: null,
      recentProcesses: [],
      showRacingLog: false,
    };
    processStates.set(sessionId, state);
  }
  return state;
}

/**
 * Handle process event from server.
 */
export function handleProcessEvent(sessionId: string, payload: ProcessEventPayload): void {
  const state = getProcessState(sessionId);

  if (payload.Type === 'Exec' && payload.Name) {
    const entry: RacingLogEntry = {
      pid: payload.Pid,
      name: payload.Name,
      commandLine: payload.CommandLine,
      timestamp: Date.now(),
    };

    state.recentProcesses.push(entry);
    if (state.recentProcesses.length > MAX_RACING_LOG_ENTRIES) {
      state.recentProcesses.shift();
    }

    state.showRacingLog = true;
    resetHideTimer(sessionId, state);
    notifyStateChange(sessionId, state);

    log.verbose(() => `Process exec: ${payload.Name} (${payload.Pid})`);
  } else if (payload.Type === 'Exit') {
    log.verbose(() => `Process exit: ${payload.Pid}`);
  }
}

/**
 * Handle foreground process change from server.
 */
export function handleForegroundChange(sessionId: string, payload: ForegroundChangePayload): void {
  const state = getProcessState(sessionId);

  state.foregroundPid = payload.Pid;
  state.foregroundName = payload.Name;
  state.foregroundCwd = payload.Cwd ?? null;

  notifyStateChange(sessionId, state);

  if (payload.Name && payload.Cwd && getSessionShellType) {
    const shellType = getSessionShellType(sessionId);
    if (shellType) {
      recordCommand(shellType, payload.Name, payload.Cwd);
    }
  }

  log.verbose(() => `Foreground: ${payload.Name} (${payload.Pid}) in ${payload.Cwd}`);
}

/**
 * Clear process state for a session.
 */
export function clearProcessState(sessionId: string): void {
  const timer = hideTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    hideTimers.delete(sessionId);
  }
  processStates.delete(sessionId);
}

/**
 * Get racing log display text.
 */
export function getRacingLogText(sessionId: string): string {
  const state = processStates.get(sessionId);
  if (!state || state.recentProcesses.length === 0) {
    return '';
  }

  return state.recentProcesses
    .map((e) => {
      if (e.commandLine) {
        const truncated =
          e.commandLine.length > 20 ? e.commandLine.slice(0, 20) + '\u2026' : e.commandLine;
        return truncated;
      }
      return e.name;
    })
    .join(' \u2192 ');
}

/**
 * Check if racing log should be visible.
 */
export function isRacingLogVisible(sessionId: string): boolean {
  const state = processStates.get(sessionId);
  return state?.showRacingLog ?? false;
}

/**
 * Get foreground process display info.
 */
export function getForegroundInfo(sessionId: string): { name: string | null; cwd: string | null } {
  const state = processStates.get(sessionId);
  return {
    name: state?.foregroundName ?? null,
    cwd: state?.foregroundCwd ?? null,
  };
}

function resetHideTimer(sessionId: string, state: ProcessState): void {
  const existing = hideTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    state.showRacingLog = false;
    hideTimers.delete(sessionId);
    notifyStateChange(sessionId, state);
  }, RACING_LOG_HIDE_DELAY);

  hideTimers.set(sessionId, timer);
}

function notifyStateChange(sessionId: string, state: ProcessState): void {
  if (onProcessStateChanged) {
    onProcessStateChanged(sessionId, state);
  }
}
