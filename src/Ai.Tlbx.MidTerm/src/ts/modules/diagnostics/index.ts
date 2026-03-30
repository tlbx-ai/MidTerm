/**
 * Diagnostics Module
 *
 * Displays file paths, reload settings, latency measurements, and overlay.
 */

export { initDiagnosticsPanel, startLatencyMeasurement, stopLatencyMeasurement } from './panel';
export {
  enableLatencyOverlay,
  disableLatencyOverlay,
  isLatencyOverlayEnabled,
  reattachOverlay,
} from './latencyOverlay';
export {
  enableGitStatusOverlay,
  disableGitStatusOverlay,
  isGitStatusOverlayEnabled,
} from './gitStatusOverlay';
export {
  clearTerminalKeyLog,
  getTerminalKeyLogLines,
  isTerminalKeyLogEnabled,
  recordTerminalKeyLog,
  setTerminalKeyLogEnabled,
  subscribeTerminalKeyLog,
} from './terminalKeyLog';
