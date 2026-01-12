/**
 * Process Module
 *
 * Exports process monitoring functionality.
 */

export {
  registerProcessStateCallback,
  registerShellTypeLookup,
  getProcessState,
  handleProcessEvent,
  handleForegroundChange,
  clearProcessState,
  getRacingLogText,
  isRacingLogVisible,
  getForegroundInfo,
} from './processMonitor';
