/**
 * Diagnostics Panel Module
 *
 * Handles the diagnostics log viewer UI in the settings panel.
 * Supports Frontend (IndexedDB), Server (WebSocket), and Session logs.
 */

import { LogLevel, LOG_LEVEL_NAMES } from '../logging';
import { readLogEntries, clearLogs } from '../logging';
import {
  connectLogsWebSocket,
  disconnectLogsWebSocket,
  setOnLogEntry,
  setOnHistory,
  setOnSessions,
  setOnConnectionChange,
  subscribeMt,
  unsubscribeMt,
  subscribeSession,
  unsubscribeSession,
  requestHistory,
  requestSessions,
  isConnected,
  type ServerLogEntry,
  type LogHistoryResponse,
  type LogSessionsResponse,
  type LogSessionInfo
} from './logsChannel';

type DiagnosticsTab = 'frontend' | 'server' | 'sessions';

interface DisplayEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
}

let currentTab: DiagnosticsTab = 'frontend';
let minLevel: LogLevel = LogLevel.Warn;
let searchFilter = '';
let liveTail = true;
let displayedEntries: DisplayEntry[] = [];
let refreshInterval: number | null = null;
let selectedSessionId: string | null = null;
let sessionsList: LogSessionInfo[] = [];

/**
 * Initialize the diagnostics panel
 */
export function initDiagnosticsPanel(): void {
  bindTabEvents();
  bindControlEvents();
  setupWebSocketCallbacks();
  startRefreshLoop();
}

/**
 * Setup WebSocket callbacks
 */
function setupWebSocketCallbacks(): void {
  setOnLogEntry(handleLogEntry);
  setOnHistory(handleHistory);
  setOnSessions(handleSessions);
  setOnConnectionChange((connected) => {
    if (connected) {
      // Re-subscribe on reconnect
      if (currentTab === 'server') {
        subscribeMt();
        requestHistory('mt');
      } else if (currentTab === 'sessions' && selectedSessionId) {
        subscribeSession(selectedSessionId);
        requestHistory('mthost', selectedSessionId);
      }
      requestSessions();
    }
  });
}

/**
 * Bind tab switching events
 */
function bindTabEvents(): void {
  const tabs = document.querySelectorAll('.diag-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab') as DiagnosticsTab;
      if (tabName) {
        switchTab(tabName);
      }
    });
  });
}

/**
 * Switch to a different tab
 */
function switchTab(tab: DiagnosticsTab): void {
  // Unsubscribe from current tab's streams
  if (currentTab === 'server') {
    unsubscribeMt();
  } else if (currentTab === 'sessions' && selectedSessionId) {
    unsubscribeSession(selectedSessionId);
  }

  currentTab = tab;

  // Update tab UI
  document.querySelectorAll('.diag-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
  });

  // Show/hide session picker
  const sessionSelect = document.getElementById('diag-session-select');
  if (sessionSelect) {
    sessionSelect.classList.toggle('hidden', tab !== 'sessions');
  }

  // Show/hide clear button (only for frontend)
  const clearBtn = document.getElementById('diag-clear');
  if (clearBtn) {
    clearBtn.style.display = tab === 'frontend' ? '' : 'none';
  }

  // Clear and refresh
  displayedEntries = [];

  // Connect/subscribe based on tab
  if (tab === 'server' || tab === 'sessions') {
    if (!isConnected()) {
      connectLogsWebSocket();
    }

    if (tab === 'server') {
      subscribeMt();
      requestHistory('mt');
    } else if (tab === 'sessions') {
      requestSessions();
      if (selectedSessionId) {
        subscribeSession(selectedSessionId);
        requestHistory('mthost', selectedSessionId);
      }
    }
  }

  refreshLogs();
}

/**
 * Bind control events (filter, search, etc.)
 */
function bindControlEvents(): void {
  const levelFilter = document.getElementById('diag-level-filter') as HTMLSelectElement | null;
  if (levelFilter) {
    levelFilter.addEventListener('change', () => {
      minLevel = parseInt(levelFilter.value, 10) as LogLevel;
      refreshLogs();
    });
  }

  const searchInput = document.getElementById('diag-search') as HTMLInputElement | null;
  if (searchInput) {
    let searchTimeout: number | null = null;
    searchInput.addEventListener('input', () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = window.setTimeout(() => {
        searchFilter = searchInput.value.toLowerCase();
        refreshLogs();
      }, 200);
    });
  }

  const liveTailCheckbox = document.getElementById('diag-live-tail') as HTMLInputElement | null;
  if (liveTailCheckbox) {
    liveTailCheckbox.addEventListener('change', () => {
      liveTail = liveTailCheckbox.checked;
      if (liveTail) {
        scrollToBottom();
      }
    });
  }

  const copyBtn = document.getElementById('diag-copy-all');
  if (copyBtn) {
    copyBtn.addEventListener('click', copyAllLogs);
  }

  const clearBtn = document.getElementById('diag-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (currentTab === 'frontend') {
        await clearLogs();
        displayedEntries = [];
        refreshLogs();
      }
    });
  }

  const sessionPicker = document.getElementById('diag-session-picker') as HTMLSelectElement | null;
  if (sessionPicker) {
    sessionPicker.addEventListener('change', () => {
      // Unsubscribe from old session
      if (selectedSessionId) {
        unsubscribeSession(selectedSessionId);
      }

      selectedSessionId = sessionPicker.value || null;
      displayedEntries = [];

      if (selectedSessionId) {
        subscribeSession(selectedSessionId);
        requestHistory('mthost', selectedSessionId);
      }
      refreshLogs();
    });
  }
}

/**
 * Handle incoming log entry from WebSocket
 */
function handleLogEntry(entry: ServerLogEntry): void {
  if (currentTab === 'server' && entry.source === 'mt') {
    addDisplayEntry(entry);
  } else if (currentTab === 'sessions' && entry.source === 'mthost' &&
             entry.sessionId === selectedSessionId) {
    addDisplayEntry(entry);
  }
}

/**
 * Add an entry to displayed logs
 */
function addDisplayEntry(entry: ServerLogEntry): void {
  const levelNum = levelStringToNumber(entry.level);
  if (levelNum > minLevel) return;

  const displayEntry: DisplayEntry = {
    timestamp: entry.timestamp,
    level: entry.level,
    module: entry.source === 'mt' ? 'mt' : `mthost-${entry.sessionId?.slice(0, 4) || ''}`,
    message: entry.message
  };

  if (searchFilter && !matchesSearch(displayEntry)) return;

  displayedEntries.push(displayEntry);
  updateDisplay();

  if (liveTail) {
    scrollToBottom();
  }
}

/**
 * Handle history response from WebSocket
 */
function handleHistory(response: LogHistoryResponse): void {
  const entries = response.entries.filter((e) => {
    const levelNum = levelStringToNumber(e.level);
    if (levelNum > minLevel) return false;
    const displayEntry: DisplayEntry = {
      timestamp: e.timestamp,
      level: e.level,
      module: e.source === 'mt' ? 'mt' : `mthost-${e.sessionId?.slice(0, 4) || ''}`,
      message: e.message
    };
    return !searchFilter || matchesSearch(displayEntry);
  });

  displayedEntries = entries.map((e) => ({
    timestamp: e.timestamp,
    level: e.level,
    module: e.source === 'mt' ? 'mt' : `mthost-${e.sessionId?.slice(0, 4) || ''}`,
    message: e.message
  }));

  updateDisplay();
  if (liveTail) {
    scrollToBottom();
  }
}

/**
 * Handle sessions list response from WebSocket
 */
function handleSessions(response: LogSessionsResponse): void {
  sessionsList = response.sessions;
  updateSessionPicker();
}

/**
 * Update the session picker dropdown
 */
function updateSessionPicker(): void {
  const picker = document.getElementById('diag-session-picker') as HTMLSelectElement | null;
  if (!picker) return;

  const currentValue = picker.value;
  picker.innerHTML = '<option value="">Select session...</option>';

  sessionsList.forEach((session) => {
    const option = document.createElement('option');
    option.value = session.id;
    option.textContent = `${session.id} ${session.active ? '(active)' : ''} - ${session.logCount} entries`;
    if (session.id === currentValue) {
      option.selected = true;
    }
    picker.appendChild(option);
  });
}

/**
 * Convert level string to number
 */
function levelStringToNumber(level: string): number {
  switch (level.toLowerCase()) {
    case 'exception': return LogLevel.Exception;
    case 'error': return LogLevel.Error;
    case 'warn': return LogLevel.Warn;
    case 'info': return LogLevel.Info;
    case 'verbose': return LogLevel.Verbose;
    default: return LogLevel.Verbose;
  }
}

/**
 * Check if entry matches search filter
 */
function matchesSearch(entry: DisplayEntry): boolean {
  return entry.message.toLowerCase().includes(searchFilter) ||
         entry.module.toLowerCase().includes(searchFilter);
}

/**
 * Start the refresh loop for live updates (frontend only)
 */
function startRefreshLoop(): void {
  if (refreshInterval) return;
  refreshInterval = window.setInterval(() => {
    if (liveTail && currentTab === 'frontend') {
      refreshLogs();
    }
  }, 1000);
}

/**
 * Refresh logs from the current source
 */
async function refreshLogs(): Promise<void> {
  const content = document.getElementById('diag-log-content');
  const countEl = document.getElementById('diag-entry-count');
  if (!content) return;

  if (currentTab === 'frontend') {
    try {
      const entries = await readLogEntries({ minLevel, limit: 500 });

      // Apply search filter
      let filtered = entries;
      if (searchFilter) {
        filtered = entries.filter((e) =>
          e.message.toLowerCase().includes(searchFilter) ||
          e.module.toLowerCase().includes(searchFilter)
        );
      }

      // Convert to display format and reverse for oldest first
      displayedEntries = filtered.reverse().map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        level: LOG_LEVEL_NAMES[e.level].toLowerCase(),
        module: e.module,
        message: e.message
      }));
    } catch {
      displayedEntries = [];
    }
  } else if (currentTab === 'server') {
    if (!isConnected()) {
      content.innerHTML = '<div class="diag-connecting">Connecting to server...</div>';
      if (countEl) countEl.textContent = '0 entries';
      return;
    }
  } else if (currentTab === 'sessions') {
    if (!selectedSessionId) {
      content.innerHTML = '<div class="diag-empty">Select a session to view logs</div>';
      if (countEl) countEl.textContent = '0 entries';
      return;
    }
    if (!isConnected()) {
      content.innerHTML = '<div class="diag-connecting">Connecting to server...</div>';
      if (countEl) countEl.textContent = '0 entries';
      return;
    }
  }

  updateDisplay();
}

/**
 * Update the display with current entries
 */
function updateDisplay(): void {
  const content = document.getElementById('diag-log-content');
  const countEl = document.getElementById('diag-entry-count');
  if (!content) return;

  if (displayedEntries.length === 0) {
    content.innerHTML = '<div class="diag-empty">No log entries</div>';
    if (countEl) countEl.textContent = '0 entries';
    return;
  }

  content.innerHTML = displayedEntries.map(renderDisplayEntry).join('');
  if (countEl) countEl.textContent = `${displayedEntries.length} entries`;
}

/**
 * Render a single display entry to HTML
 */
function renderDisplayEntry(entry: DisplayEntry): string {
  const time = entry.timestamp.slice(11, 23);
  const levelName = entry.level.toLowerCase();
  const escapedMessage = escapeHtml(entry.message);
  const escapedModule = escapeHtml(entry.module);

  return `<div class="diag-log-entry">
    <span class="diag-log-time">${time}</span>
    <span class="diag-log-level ${levelName}">${entry.level.toUpperCase()}</span>
    <span class="diag-log-module">${escapedModule}</span>
    <span class="diag-log-message">${escapedMessage}</span>
  </div>`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Scroll log viewer to bottom
 */
function scrollToBottom(): void {
  const content = document.getElementById('diag-log-content');
  if (content) {
    content.scrollTop = content.scrollHeight;
  }
}

/**
 * Copy all displayed logs to clipboard
 */
async function copyAllLogs(): Promise<void> {
  const lines = displayedEntries.map((entry) => {
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}`;
  });

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

/**
 * Stop the refresh loop (call when settings panel closes)
 */
export function stopDiagnosticsRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  disconnectLogsWebSocket();
}
