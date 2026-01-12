/**
 * History Dropdown Module
 *
 * UI component for displaying and interacting with command history.
 */

import {
  getHistoryEntries,
  getEntryDisplayText,
  removeEntry,
  registerHistoryCallback,
  type CommandHistoryEntry,
} from './commandHistory';
import { icon } from '../../constants';

let dropdownEl: HTMLElement | null = null;
let isOpen = false;
let onSpawnSession: ((entry: CommandHistoryEntry) => void) | null = null;

/**
 * Initialize the history dropdown.
 */
export function initHistoryDropdown(spawnCallback: (entry: CommandHistoryEntry) => void): void {
  onSpawnSession = spawnCallback;
  createDropdownElement();
  registerHistoryCallback(updateDropdownContent);
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

  updateDropdownContent();
  dropdownEl.classList.add('visible');
  isOpen = true;

  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 0);
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

function updateDropdownContent(): void {
  if (!dropdownEl) return;

  const content = dropdownEl.querySelector('.history-dropdown-content');
  const empty = dropdownEl.querySelector('.history-dropdown-empty');
  if (!content || !empty) return;

  const entries = getHistoryEntries().slice(0, 10);

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
    <div class="history-item" data-id="${entry.id}">
      <div class="history-item-info">
        <span class="history-item-text">${escapeHtml(getEntryDisplayText(entry))}</span>
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
      if ((e.target as Element).closest('.history-item-delete')) return;

      const entry = entries.find((en) => en.id === id);
      if (entry && onSpawnSession) {
        closeHistoryDropdown();
        onSpawnSession(entry);
      }
    });
  });

  content.querySelectorAll('.history-item-delete').forEach((btn) => {
    const item = btn.closest('.history-item');
    const id = item?.getAttribute('data-id');
    if (!id) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeEntry(id);
    });
  });
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
