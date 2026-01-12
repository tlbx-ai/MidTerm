/**
 * History Module
 *
 * Exports command history functionality.
 */

export {
  initializeCommandHistory,
  registerHistoryCallback,
  recordCommand,
  getHistoryEntries,
  clearHistory,
  removeEntry,
  setDisplayName,
  getEntryDisplayText,
  type CommandHistoryEntry,
} from './commandHistory';

export {
  initHistoryDropdown,
  toggleHistoryDropdown,
  openHistoryDropdown,
  closeHistoryDropdown,
} from './historyDropdown';
