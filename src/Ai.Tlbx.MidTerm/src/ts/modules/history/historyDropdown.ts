/**
 * History Dropdown Module
 *
 * UI component for displaying and interacting with command history.
 * Uses backend API for persistence.
 */

import { fetchHistory, toggleStar, removeHistoryEntry, type LaunchEntry } from './historyApi';
import { icon } from '../../constants';
import { createLogger } from '../logging';
import { formatRuntimeDisplay } from '../sidebar/processDisplay';

const log = createLogger('history-dropdown');

let dropdownEl: HTMLElement | null = null;
let isOpen = false;
let cachedEntries: LaunchEntry[] = [];
let onSpawnSession: ((entry: LaunchEntry) => void) | null = null;

/**
 * Initialize the history dropdown.
 */
export function initHistoryDropdown(spawnCallback: (entry: LaunchEntry) => void): void {
  onSpawnSession = spawnCallback;
  createDropdownElement();
  loadHistory();
}

/**
 * Refresh history from backend.
 */
export function refreshHistory(): void {
  loadHistory();
}

/**
 * Toggle the history dropdown visibility.
 */
export function toggleHistoryDropdown(): void {
  if (isOpen) {
    closeHistoryDropdown();
  } else {
    openHistoryDropdown();
  }
}

/**
 * Open the history dropdown.
 */
export function openHistoryDropdown(): void {
  if (!dropdownEl) return;

  loadHistory().then(() => {
    renderDropdownContent();
    dropdownEl?.classList.add('visible');
    isOpen = true;

    setTimeout(() => {
      document.addEventListener('click', handleOutsideClick);
    }, 0);
  });
}

/**
 * Close the history dropdown.
 */
export function closeHistoryDropdown(): void {
  if (!dropdownEl) return;

  dropdownEl.classList.remove('visible');
  isOpen = false;
  document.removeEventListener('click', handleOutsideClick);
}

async function loadHistory(): Promise<void> {
  try {
    cachedEntries = await fetchHistory();
  } catch (e) {
    log.warn(() => `Failed to load history: ${e}`);
    cachedEntries = [];
  }
}

function createDropdownElement(): void {
  dropdownEl = document.createElement('div');
  dropdownEl.className = 'history-dropdown';
  dropdownEl.innerHTML = `
    <div class="history-dropdown-header">
      <span>Quick Launch</span>
    </div>
    <div class="history-dropdown-content"></div>
    <div class="history-dropdown-empty">No history yet</div>
  `;

  const headerArea = document.querySelector('.sidebar-header');
  if (headerArea) {
    headerArea.appendChild(dropdownEl);
  }
}

function renderDropdownContent(): void {
  if (!dropdownEl) return;

  const content = dropdownEl.querySelector('.history-dropdown-content');
  const empty = dropdownEl.querySelector('.history-dropdown-empty');
  if (!content || !empty) return;

  const pinnedEntries = cachedEntries.filter((e) => e.isStarred);
  const recentEntries = cachedEntries.filter((e) => !e.isStarred).slice(0, 5);

  if (pinnedEntries.length === 0 && recentEntries.length === 0) {
    content.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  content.classList.remove('hidden');
  empty.classList.add('hidden');
  content.innerHTML = '';

  if (pinnedEntries.length > 0) {
    const pinnedHeader = document.createElement('div');
    pinnedHeader.className = 'history-section-header';
    pinnedHeader.textContent = '\u2b50 Pinned';
    content.appendChild(pinnedHeader);

    pinnedEntries.forEach((entry) => {
      content.appendChild(createHistoryItem(entry));
    });
  }

  if (recentEntries.length > 0) {
    const recentHeader = document.createElement('div');
    recentHeader.className = 'history-section-header';
    recentHeader.textContent = '\ud83d\udd70 Recent';
    content.appendChild(recentHeader);

    recentEntries.forEach((entry) => {
      content.appendChild(createHistoryItem(entry));
    });
  }
}

function createHistoryItem(entry: LaunchEntry): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'history-item';
  item.dataset.id = entry.id;

  const starBtn = document.createElement('button');
  starBtn.className = 'history-item-star' + (entry.isStarred ? ' starred' : '');
  starBtn.title = entry.isStarred ? 'Unstar' : 'Star';
  starBtn.textContent = entry.isStarred ? '\u2605' : '\u2606';
  starBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!entry.id) return;
    starBtn.disabled = true;
    starBtn.classList.add('loading');
    await toggleStar(entry.id);
    await loadHistory();
    renderDropdownContent();
  });
  item.appendChild(starBtn);

  const infoDiv = document.createElement('div');
  infoDiv.className = 'history-item-info';

  const fgIndicator = createForegroundIndicator(
    entry.workingDirectory ?? '',
    entry.commandLine ?? null,
    entry.executable ?? '',
  );
  infoDiv.appendChild(fgIndicator);

  const meta = document.createElement('span');
  meta.className = 'history-item-meta';
  meta.textContent = `${entry.weight}x`;
  infoDiv.appendChild(meta);

  item.appendChild(infoDiv);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'history-item-delete';
  deleteBtn.title = 'Remove';
  deleteBtn.innerHTML = icon('close');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!entry.id) return;
    if (entry.isStarred) {
      if (!confirm('Delete starred item?')) {
        return;
      }
    }
    await removeHistoryEntry(entry.id);
    await loadHistory();
    renderDropdownContent();
  });
  item.appendChild(deleteBtn);

  item.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('.history-item-delete') || target.closest('.history-item-star')) {
      return;
    }
    if (onSpawnSession) {
      closeHistoryDropdown();
      onSpawnSession(entry);
    }
  });

  return item;
}

/**
 * Create foreground indicator element matching sidebar style.
 * Layout: ...directory> process...
 */
function createForegroundIndicator(
  cwd: string,
  commandLine: string | null,
  processName: string,
): HTMLElement {
  const container = document.createElement('span');
  container.className = 'session-foreground';

  const cmdDisplay = formatRuntimeDisplay(processName, commandLine);
  container.title = `${commandLine ?? processName}\n${cwd}`;

  const cwdSpan = document.createElement('span');
  cwdSpan.className = 'fg-cwd';
  cwdSpan.textContent = cwd;
  container.appendChild(cwdSpan);

  const separator = document.createElement('span');
  separator.className = 'fg-separator';
  separator.textContent = '>';
  container.appendChild(separator);

  const processSpan = document.createElement('span');
  processSpan.className = 'fg-process';
  processSpan.textContent = cmdDisplay;
  container.appendChild(processSpan);

  return container;
}

function handleOutsideClick(e: MouseEvent): void {
  if (!dropdownEl) return;

  const target = e.target as Element;
  if (!dropdownEl.contains(target) && !target.closest('.btn-history')) {
    closeHistoryDropdown();
  }
}

// Re-export LaunchEntry for main.ts
export type { LaunchEntry };
