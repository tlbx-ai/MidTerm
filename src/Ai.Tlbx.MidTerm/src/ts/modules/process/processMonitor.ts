/**
 * Process Monitor Module
 *
 * Manages foreground process state for terminal sessions.
 * Tracks the direct child process for UI display (sidebar).
 */

import type { ProcessState, ForegroundChangePayload } from '../../types';
import { createLogger } from '../logging';

const log = createLogger('process');

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
    };
    processStates.set(sessionId, state);
  }
  return state;
}

/**
 * Handle foreground process change from server.
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
  foregroundPid: number | null,
  foregroundName: string | null,
  foregroundCommandLine: string | null,
  currentDirectory: string | null,
): void {
  if (!foregroundPid && !foregroundName && !currentDirectory) return;

  const state = getProcessState(sessionId);
  const changed =
    state.foregroundPid !== foregroundPid ||
    state.foregroundName !== foregroundName ||
    state.foregroundCommandLine !== foregroundCommandLine ||
    state.foregroundCwd !== currentDirectory;

  if (changed) {
    state.foregroundPid = foregroundPid;
    state.foregroundName = foregroundName;
    state.foregroundCommandLine = foregroundCommandLine;
    state.foregroundCwd = currentDirectory;
    notifyStateChange(sessionId, state);
    log.verbose(() => `Initialized from session: ${foregroundName} in ${currentDirectory}`);
  }
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
