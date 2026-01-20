/**
 * Process Module
 *
 * Exports process monitoring functionality.
 */

export {
  addProcessStateListener,
  getProcessState,
  handleProcessEvent,
  handleForegroundChange,
  clearProcessState,
  initializeFromSession,
  getRacingLogText,
  getFullRacingLog,
  isRacingLogVisible,
  getForegroundInfo,
} from './processMonitor';
