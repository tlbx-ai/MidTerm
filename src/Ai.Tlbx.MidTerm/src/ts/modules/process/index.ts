/**
 * Process Module
 *
 * Exports foreground process monitoring functionality.
 */

export {
  addProcessStateListener,
  getProcessState,
  handleForegroundChange,
  initializeFromSession,
  getForegroundInfo,
  handleOsc7Cwd,
} from './processMonitor';
