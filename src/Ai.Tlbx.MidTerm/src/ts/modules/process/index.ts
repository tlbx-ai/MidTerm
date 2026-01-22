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
} from './processMonitor';
