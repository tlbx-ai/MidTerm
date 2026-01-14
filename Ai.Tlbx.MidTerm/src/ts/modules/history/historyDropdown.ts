/**
 * History Dropdown Module
 *
 * UI component for displaying and interacting with command history.
 * Uses backend API for persistence.
 */

import { fetchHistory, toggleStar, removeHistoryEntry, type LaunchEntry } from './historyApi';
import { icon } from '../../constants';
import { createLogger } from '../logging';

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

  const entries = cachedEntries.slice(0, 10);

  if (entries.length === 0) {
    content.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  content.classList.remove('hidden');
  empty.classList.add('hidden');

  content.innerHTML = entries
    .map(
      (entry) => `
    <div class="history-item" data-id="${entry.id}" title="${escapeHtml(getFullCommandLine(entry))}">
      <button class="history-item-star ${entry.isStarred ? 'starred' : ''}" title="${entry.isStarred ? 'Unstar' : 'Star'}">
        ${entry.isStarred ? '\u2605' : '\u2606'}
      </button>
      <div class="history-item-info">
        <span class="history-item-text truncate">${escapeHtml(getDisplayText(entry))}</span>
        <span class="history-item-meta">${entry.weight}x</span>
      </div>
      <button class="history-item-delete" title="Remove">${icon('close')}</button>
    </div>
  `,
    )
    .join('');

  content.querySelectorAll('.history-item').forEach((item) => {
    const id = item.getAttribute('data-id');
    if (!id) return;

    item.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (target.closest('.history-item-delete') || target.closest('.history-item-star')) {
        return;
      }

      const entry = cachedEntries.find((en) => en.id === id);
      if (entry && onSpawnSession) {
        closeHistoryDropdown();
        onSpawnSession(entry);
      }
    });
  });

  content.querySelectorAll('.history-item-star').forEach((btn) => {
    const item = btn.closest('.history-item');
    const id = item?.getAttribute('data-id');
    if (!id) return;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const starBtn = btn as HTMLButtonElement;
      starBtn.disabled = true;
      starBtn.classList.add('loading');

      await toggleStar(id);
      await loadHistory();
      renderDropdownContent();
    });
  });

  content.querySelectorAll('.history-item-delete').forEach((btn) => {
    const item = btn.closest('.history-item');
    const id = item?.getAttribute('data-id');
    if (!id) return;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      const entry = cachedEntries.find((en) => en.id === id);
      if (entry?.isStarred) {
        if (!confirm('Delete starred item?')) {
          return;
        }
      }

      await removeHistoryEntry(id);
      await loadHistory();
      renderDropdownContent();
    });
  });
}

function getDisplayText(entry: LaunchEntry): string {
  const cmd = entry.commandLine ?? entry.executable;
  const truncatedCmd = cmd.length > 25 ? cmd.slice(0, 25) + '\u2026' : cmd;
  const dir = shortenPath(entry.workingDirectory);
  return `${truncatedCmd} \u2192 ${dir}`;
}

function getFullCommandLine(entry: LaunchEntry): string {
  const cmd = entry.commandLine ?? entry.executable;
  return `${cmd}\n${entry.workingDirectory}`;
}

function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) {
    return path;
  }

  const first = parts[0];
  const second = parts[1];

  if (first === '' && second === 'home') {
    return '~/' + parts.slice(3).join('/');
  }

  if (first && /^[A-Z]:$/i.test(first)) {
    if (parts.length > 3) {
      return first + '/.../' + parts.slice(-2).join('/');
    }
  }

  return parts.slice(-2).join('/');
}

function handleOutsideClick(e: MouseEvent): void {
  if (!dropdownEl) return;

  const target = e.target as Element;
  if (!dropdownEl.contains(target) && !target.closest('.btn-history')) {
    closeHistoryDropdown();
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-export LaunchEntry for main.ts
export type { LaunchEntry };
