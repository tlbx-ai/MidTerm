/**
 * History Module
 *
 * Exports command history functionality.
 * Backend-persisted via /api/history endpoints.
 */

export {
  initHistoryDropdown,
  toggleHistoryDropdown,
  openHistoryDropdown,
  closeHistoryDropdown,
  refreshHistory,
  type LaunchEntry,
} from './historyDropdown';

export { fetchHistory, toggleStar, removeHistoryEntry, createHistoryEntry } from './historyApi';
