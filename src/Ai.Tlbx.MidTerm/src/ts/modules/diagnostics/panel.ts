/**
 * Diagnostics Panel Module
 *
 * Handles the diagnostics log viewer UI in the settings panel.
 * Uses HTTP polling for log file tailing.
 */

import { LogLevel } from '../logging';

type DiagnosticsTab = 'server' | 'sessions';

interface LogFileInfo {
  name: string;
  source: string;
  sessionId?: string;
  size: number;
  modified: string;
  isActive: boolean;
}

interface LogEntry {
  messageType: string;
  source: string;
  sessionId?: string;
  timestamp: string;
  level: string;
  message: string;
}

interface LogReadResponse {
  entries: LogEntry[];
  position: number;
  fileName: string;
}

interface LogFilesResponse {
  files: LogFileInfo[];
}

interface DisplayEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
}

let currentTab: DiagnosticsTab = 'server';
let minLevel: LogLevel = LogLevel.Warn;
let searchFilter = '';
let liveTail = true;
let displayedEntries: DisplayEntry[] = [];
let selectedFile: string | null = null;
let logFiles: LogFileInfo[] = [];
let tailPosition = 0;
let pollTimer: number | null = null;

const POLL_INTERVAL = 500;

interface PathsResponse {
  settingsFile: string;
  secretsFile: string;
  certificateFile: string;
  logDirectory: string;
}

/**
 * Initialize the diagnostics panel
 */
export function initDiagnosticsPanel(): void {
  bindTabEvents();
  bindControlEvents();
  loadLogFiles();
  loadPaths();
  bindReloadSettingsButton();
}

/**
 * Load available log files
 */
async function loadLogFiles(): Promise<void> {
  try {
    const response = await fetch('/api/logs/files');
    if (!response.ok) return;

    const data = (await response.json()) as LogFilesResponse;
    logFiles = data.files;

    updateSessionPicker();

    // Auto-select mt.log for server tab
    if (currentTab === 'server') {
      const mtFile = logFiles.find((f) => f.source === 'mt' && f.name === 'mt.log');
      if (mtFile) {
        selectedFile = mtFile.name;
        await loadFileContent();
      }
    }
  } catch (e) {
    console.error('Failed to load log files:', e);
  }
}

/**
 * Load content from selected file
 */
async function loadFileContent(): Promise<void> {
  if (!selectedFile) {
    displayedEntries = [];
    updateDisplay();
    return;
  }

  try {
    const response = await fetch(
      `/api/logs/read?file=${encodeURIComponent(selectedFile)}&lines=200&fromEnd=true`,
    );
    if (!response.ok) return;

    const data = (await response.json()) as LogReadResponse;
    tailPosition = data.position;

    displayedEntries = data.entries.filter(filterEntry).map((e) => ({
      timestamp: e.timestamp,
      level: e.level,
      module: e.source === 'mt' ? 'mt' : `mthost-${e.sessionId?.slice(0, 4) || ''}`,
      message: e.message,
    }));

    updateDisplay();
    if (liveTail) {
      scrollToBottom();
    }

    startPolling();
  } catch (e) {
    console.error('Failed to load file content:', e);
  }
}

/**
 * Start polling for new content
 */
function startPolling(): void {
  stopPolling();
  if (liveTail && selectedFile) {
    pollTimer = window.setInterval(pollForNewContent, POLL_INTERVAL);
  }
}

/**
 * Stop polling
 */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Poll for new content since last position
 */
async function pollForNewContent(): Promise<void> {
  if (!selectedFile || !liveTail) return;

  try {
    const response = await fetch(
      `/api/logs/tail?file=${encodeURIComponent(selectedFile)}&position=${tailPosition}`,
    );
    if (!response.ok) return;

    const data = (await response.json()) as LogReadResponse;

    if (data.entries.length > 0) {
      tailPosition = data.position;

      const newEntries = data.entries.filter(filterEntry).map((e) => ({
        timestamp: e.timestamp,
        level: e.level,
        module: e.source === 'mt' ? 'mt' : `mthost-${e.sessionId?.slice(0, 4) || ''}`,
        message: e.message,
      }));

      displayedEntries.push(...newEntries);

      // Limit displayed entries to prevent memory issues
      if (displayedEntries.length > 2000) {
        displayedEntries = displayedEntries.slice(-1500);
      }

      updateDisplay();
      if (liveTail) {
        scrollToBottom();
      }
    }
  } catch {
    // Ignore polling errors
  }
}

/**
 * Filter entry by level and search
 */
function filterEntry(entry: LogEntry): boolean {
  const levelNum = levelStringToNumber(entry.level);
  if (levelNum > minLevel) return false;

  if (searchFilter) {
    const lowerSearch = searchFilter.toLowerCase();
    if (
      !entry.message.toLowerCase().includes(lowerSearch) &&
      !entry.source.toLowerCase().includes(lowerSearch)
    ) {
      return false;
    }
  }

  return true;
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
  currentTab = tab;
  stopPolling();

  // Update tab UI
  document.querySelectorAll('.diag-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
  });

  // Show/hide session picker
  const sessionSelect = document.getElementById('diag-session-select');
  if (sessionSelect) {
    sessionSelect.classList.toggle('hidden', tab !== 'sessions');
  }

  // Clear and refresh
  displayedEntries = [];
  selectedFile = null;

  if (tab === 'server') {
    const mtFile = logFiles.find((f) => f.source === 'mt' && f.name === 'mt.log');
    if (mtFile) {
      selectedFile = mtFile.name;
    }
  }

  loadFileContent();
}

/**
 * Bind control events (filter, search, etc.)
 */
function bindControlEvents(): void {
  const levelFilter = document.getElementById('diag-level-filter') as HTMLSelectElement | null;
  if (levelFilter) {
    levelFilter.addEventListener('change', () => {
      minLevel = parseInt(levelFilter.value, 10) as LogLevel;
      loadFileContent();
    });
  }

  const searchInput = document.getElementById('diag-search') as HTMLInputElement | null;
  if (searchInput) {
    let searchTimeout: number | null = null;
    searchInput.addEventListener('input', () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = window.setTimeout(() => {
        searchFilter = searchInput.value.toLowerCase();
        loadFileContent();
      }, 200);
    });
  }

  const liveTailCheckbox = document.getElementById('diag-live-tail') as HTMLInputElement | null;
  if (liveTailCheckbox) {
    liveTailCheckbox.addEventListener('change', () => {
      liveTail = liveTailCheckbox.checked;
      if (liveTail) {
        startPolling();
        scrollToBottom();
      } else {
        stopPolling();
      }
    });
  }

  const copyBtn = document.getElementById('diag-copy-all');
  if (copyBtn) {
    copyBtn.addEventListener('click', copyAllLogs);
  }

  const sessionPicker = document.getElementById('diag-session-picker') as HTMLSelectElement | null;
  if (sessionPicker) {
    sessionPicker.addEventListener('change', () => {
      const sessionId = sessionPicker.value;
      if (sessionId) {
        const sessionFile = logFiles.find((f) => f.sessionId === sessionId);
        if (sessionFile) {
          selectedFile = sessionFile.name;
          loadFileContent();
        }
      }
    });
  }
}

/**
 * Update the session picker dropdown
 */
function updateSessionPicker(): void {
  const picker = document.getElementById('diag-session-picker') as HTMLSelectElement | null;
  if (!picker) return;

  const currentValue = picker.value;
  picker.innerHTML = '<option value="">Select session...</option>';

  const sessionFiles = logFiles.filter((f) => f.source === 'mthost' && f.sessionId);
  sessionFiles.forEach((file) => {
    const option = document.createElement('option');
    option.value = file.sessionId || '';
    const sizeKb = Math.round(file.size / 1024);
    option.textContent = `${file.sessionId?.slice(0, 8)} ${file.isActive ? '(active)' : ''} - ${sizeKb}KB`;
    if (file.sessionId === currentValue) {
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
    case 'exception':
      return LogLevel.Exception;
    case 'error':
      return LogLevel.Error;
    case 'warn':
      return LogLevel.Warn;
    case 'info':
      return LogLevel.Info;
    case 'verbose':
      return LogLevel.Verbose;
    default:
      return LogLevel.Verbose;
  }
}

/**
 * Update the display with current entries
 */
function updateDisplay(): void {
  const content = document.getElementById('diag-log-content');
  const countEl = document.getElementById('diag-entry-count');
  const statusEl = document.getElementById('diag-connection-status');
  if (!content) return;

  if (statusEl) {
    statusEl.textContent = selectedFile ? `File: ${selectedFile}` : '';
  }

  if (displayedEntries.length === 0) {
    content.innerHTML = selectedFile
      ? '<div class="diag-empty">No log entries match current filters</div>'
      : '<div class="diag-empty">Select a log file to view</div>';
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
 * Load file paths from server
 */
async function loadPaths(): Promise<void> {
  try {
    const response = await fetch('/api/paths');
    if (!response.ok) return;

    const data = (await response.json()) as PathsResponse;

    const settingsEl = document.getElementById('path-settings');
    const secretsEl = document.getElementById('path-secrets');
    const certEl = document.getElementById('path-certificate');
    const logsEl = document.getElementById('path-logs');

    if (settingsEl) settingsEl.textContent = data.settingsFile || '-';
    if (secretsEl) secretsEl.textContent = data.secretsFile || '-';
    if (certEl) certEl.textContent = data.certificateFile || '-';
    if (logsEl) logsEl.textContent = data.logDirectory || '-';
  } catch (e) {
    console.error('Failed to load paths:', e);
  }
}

/**
 * Bind the reload settings button
 */
function bindReloadSettingsButton(): void {
  const btn = document.getElementById('btn-reload-settings');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    try {
      const response = await fetch('/api/settings/reload', { method: 'POST' });
      if (response.ok) {
        window.location.reload();
      }
    } catch (e) {
      console.error('Failed to reload settings:', e);
    } finally {
      btn.classList.remove('spinning');
    }
  });
}

/**
 * Cleanup when settings panel closes
 */
export function stopDiagnosticsRefresh(): void {
  stopPolling();
}
