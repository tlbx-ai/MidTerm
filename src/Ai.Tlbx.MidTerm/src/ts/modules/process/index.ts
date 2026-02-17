/**
 * Process Module
 *
 * Exports foreground process monitoring functionality.
 */

export {
  addProcessStateListener,
  getProcessState,
  handleForegroundChange,
  clearProcessState,
  initializeFromSession,
  getForegroundInfo,
  handleOsc7Cwd,
} from './processMonitor';
