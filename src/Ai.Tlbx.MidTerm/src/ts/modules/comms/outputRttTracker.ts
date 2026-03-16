/**
 * Output RTT Tracker
 *
 * Tracks the user-visible input->output RTT boundary for terminals.
 * We intentionally arm the measurement when the first post-input output frame
 * arrives, then complete it only when xterm finishes parsing that output.
 */

export interface OutputRttTracker {
  inputTimestamps: Map<string, number>;
  pendingOutputTimestamps: Map<string, number>;
}

export function createOutputRttTracker(): OutputRttTracker {
  return {
    inputTimestamps: new Map<string, number>(),
    pendingOutputTimestamps: new Map<string, number>(),
  };
}

export function recordOutputRttInput(
  tracker: OutputRttTracker,
  sessionId: string,
  now: number,
): void {
  tracker.inputTimestamps.set(sessionId, now);
}

export function armOutputRttMeasurement(tracker: OutputRttTracker, sessionId: string): void {
  if (tracker.pendingOutputTimestamps.has(sessionId)) {
    return;
  }

  const sent = tracker.inputTimestamps.get(sessionId);
  if (sent === undefined) {
    return;
  }

  tracker.inputTimestamps.delete(sessionId);
  tracker.pendingOutputTimestamps.set(sessionId, sent);
}

export function consumeCompletedOutputRtt(
  tracker: OutputRttTracker,
  sessionId: string,
  now: number,
): number | null {
  const sent = tracker.pendingOutputTimestamps.get(sessionId);
  if (sent === undefined) {
    return null;
  }

  tracker.pendingOutputTimestamps.delete(sessionId);
  return now - sent;
}

export function resetOutputRttTracker(tracker: OutputRttTracker): void {
  tracker.inputTimestamps.clear();
  tracker.pendingOutputTimestamps.clear();
}
