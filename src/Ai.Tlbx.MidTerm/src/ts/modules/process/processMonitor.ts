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

const log = createLogger('process');

const MAX_RACING_LOG_ENTRIES = 10;

const processStates = new Map<string, ProcessState>();

const processStateListeners: ((sessionId: string, state: ProcessState) => void)[] = [];

/**
 * Add a listener for process state changes.
 */
export function addProcessStateListener(
  callback: (sessionId: string, state: ProcessState) => void,
): void {
  processStateListeners.push(callback);
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
      foregroundCommandLine: null,
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
    notifyStateChange(sessionId, state);

    log.info(() => `Racing log now has ${state.recentProcesses.length} entries for ${sessionId}`);
  } else if (payload.Type === 'Exit') {
    log.verbose(() => `Process exit: ${payload.Pid}`);
  }
}

/**
 * Handle foreground process change from server.
 * Backend records history automatically via OnForegroundChanged event.
 */
export function handleForegroundChange(sessionId: string, payload: ForegroundChangePayload): void {
  const state = getProcessState(sessionId);

  state.foregroundPid = payload.Pid;
  state.foregroundName = payload.Name;
  state.foregroundCommandLine = payload.CommandLine ?? null;
  state.foregroundCwd = payload.Cwd ?? null;

  notifyStateChange(sessionId, state);

  log.verbose(
    () =>
      `Foreground: ${payload.Name} (${payload.Pid}) cmd=${payload.CommandLine} in ${payload.Cwd}`,
  );
}

/**
 * Clear process state for a session.
 */
export function clearProcessState(sessionId: string): void {
  processStates.delete(sessionId);
}

/**
 * Initialize process state from session data (e.g., on reconnect).
 * Only updates if the session has foreground process info.
 */
export function initializeFromSession(
  sessionId: string,
  foregroundPid: number | undefined,
  foregroundName: string | undefined,
  foregroundCommandLine: string | undefined,
  currentDirectory: string | undefined,
): void {
  if (!foregroundPid && !foregroundName) return;

  const state = getProcessState(sessionId);
  const changed =
    state.foregroundPid !== (foregroundPid ?? null) ||
    state.foregroundName !== (foregroundName ?? null) ||
    state.foregroundCommandLine !== (foregroundCommandLine ?? null) ||
    state.foregroundCwd !== (currentDirectory ?? null);

  if (changed) {
    state.foregroundPid = foregroundPid ?? null;
    state.foregroundName = foregroundName ?? null;
    state.foregroundCommandLine = foregroundCommandLine ?? null;
    state.foregroundCwd = currentDirectory ?? null;
    notifyStateChange(sessionId, state);
    log.verbose(() => `Initialized from session: ${foregroundName} in ${currentDirectory}`);
  }
}

/**
 * Get racing log display text (single line - latest entry only).
 */
export function getRacingLogText(sessionId: string): string {
  const state = processStates.get(sessionId);
  if (!state || state.recentProcesses.length === 0) {
    return '';
  }

  const latest = state.recentProcesses[state.recentProcesses.length - 1]!;
  if (latest.commandLine) {
    return latest.commandLine.length > 40
      ? latest.commandLine.slice(0, 40) + '\u2026'
      : latest.commandLine;
  }
  return latest.name;
}

/**
 * Get full racing log for hover tooltip (all entries).
 */
export function getFullRacingLog(sessionId: string): string {
  const state = processStates.get(sessionId);
  if (!state || state.recentProcesses.length === 0) {
    return '';
  }

  return state.recentProcesses
    .map((e) => {
      if (e.commandLine) {
        return e.commandLine.length > 60 ? e.commandLine.slice(0, 60) + '\u2026' : e.commandLine;
      }
      return e.name;
    })
    .join('\n');
}

/**
 * Check if racing log has entries.
 */
export function isRacingLogVisible(sessionId: string): boolean {
  const state = processStates.get(sessionId);
  return (state?.recentProcesses.length ?? 0) > 0;
}

/**
 * Get foreground process display info.
 */
export function getForegroundInfo(sessionId: string): {
  name: string | null;
  commandLine: string | null;
  cwd: string | null;
} {
  const state = processStates.get(sessionId);
  return {
    name: state?.foregroundName ?? null,
    commandLine: state?.foregroundCommandLine ?? null,
    cwd: state?.foregroundCwd ?? null,
  };
}

function notifyStateChange(sessionId: string, state: ProcessState): void {
  for (const listener of processStateListeners) {
    listener(sessionId, state);
  }
}
