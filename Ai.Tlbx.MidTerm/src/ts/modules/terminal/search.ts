/**
 * Terminal Search Module
 *
 * Handles xterm.js search addon functionality, including the search UI,
 * keyboard shortcuts, and search result navigation.
 */

import { sessionTerminals, activeSessionId } from '../../state';

import { SearchAddon } from '@xterm/addon-search';

interface SearchState {
  addon: any;
  currentIndex: number;
  totalMatches: number;
}

const searchStates = new Map<string, SearchState>();

let searchVisible = false;
let searchInput: HTMLInputElement | null = null;
let searchResults: HTMLElement | null = null;
let searchContainer: HTMLElement | null = null;

/**
 * Initialize search addon for a terminal
 */
export function initSearchForTerminal(sessionId: string, terminal: any): void {
  try {
    const addon = new SearchAddon();
    terminal.loadAddon(addon);
    searchStates.set(sessionId, { addon, currentIndex: 0, totalMatches: 0 });
  } catch {
    // Search addon failed to load
  }
}

/**
 * Clean up search state for a session
 */
export function cleanupSearchForTerminal(sessionId: string): void {
  searchStates.delete(sessionId);
}

/**
 * Show the search UI
 */
export function showSearch(): void {
  if (!searchContainer) {
    searchContainer = document.getElementById('terminal-search');
    searchInput = document.getElementById('search-input') as HTMLInputElement;
    searchResults = document.getElementById('search-results');
  }

  if (searchContainer && searchInput) {
    searchContainer.classList.remove('hidden');
    searchVisible = true;
    searchInput.focus();
    searchInput.select();
  }
}

/**
 * Hide the search UI
 */
export function hideSearch(): void {
  if (searchContainer) {
    searchContainer.classList.add('hidden');
    searchVisible = false;
  }

  // Clear decorations from active terminal
  if (activeSessionId) {
    const state = searchStates.get(activeSessionId);
    if (state?.addon) {
      state.addon.clearDecorations();
    }
  }

  // Return focus to terminal
  if (activeSessionId) {
    const termState = sessionTerminals.get(activeSessionId);
    if (termState) {
      termState.terminal.focus();
    }
  }
}

/**
 * Check if search is visible
 */
export function isSearchVisible(): boolean {
  return searchVisible;
}

/**
 * Find next match
 */
export function findNext(): void {
  if (!activeSessionId || !searchInput) return;

  const query = searchInput.value;
  if (!query) return;

  const state = searchStates.get(activeSessionId);
  if (!state?.addon) return;

  const result = state.addon.findNext(query, { incremental: false });
  updateSearchResults(result);
}

/**
 * Find previous match
 */
export function findPrevious(): void {
  if (!activeSessionId || !searchInput) return;

  const query = searchInput.value;
  if (!query) return;

  const state = searchStates.get(activeSessionId);
  if (!state?.addon) return;

  const result = state.addon.findPrevious(query);
  updateSearchResults(result);
}

/**
 * Update search results display
 */
function updateSearchResults(found: boolean): void {
  if (searchResults) {
    if (found) {
      searchResults.textContent = 'Found';
      searchResults.style.color = '';
    } else {
      searchResults.textContent = 'No matches';
      searchResults.style.color = 'var(--accent-red)';
    }
  }
}

/**
 * Bind search UI event handlers
 */
export function bindSearchEvents(): void {
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const prevBtn = document.getElementById('search-prev');
  const nextBtn = document.getElementById('search-next');
  const closeBtn = document.getElementById('search-close');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (activeSessionId && searchInput.value) {
        findNext();
      } else if (searchResults) {
        searchResults.textContent = '0/0';
        searchResults.style.color = '';
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          findPrevious();
        } else {
          findNext();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideSearch();
      }
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', findPrevious);
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', findNext);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', hideSearch);
  }
}
