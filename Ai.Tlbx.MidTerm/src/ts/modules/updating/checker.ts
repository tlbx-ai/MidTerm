/**
 * Update Checker Module
 *
 * Handles checking for updates, rendering the update panel,
 * and applying updates with server restart.
 */

import type { UpdateInfo } from '../../types';
import { updateInfo, setUpdateInfo } from '../../state';
import { createLogger } from '../logging';

const log = createLogger('updating');

const MAX_RELOAD_ATTEMPTS = 30;
const RELOAD_INTERVAL_MS = 2000;
const INITIAL_RESTART_DELAY_MS = 3000;

/**
 * Render the update panel based on current update info
 */
export function renderUpdatePanel(): void {
  const panel = document.getElementById('update-panel');
  if (!panel) return;

  if (!updateInfo || !updateInfo.available) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  const currentEl = panel.querySelector('.update-current');
  const latestEl = panel.querySelector('.update-latest');
  const noteEl = panel.querySelector('.update-note');
  const headerEl = panel.querySelector('.update-header');

  if (currentEl) currentEl.textContent = updateInfo.currentVersion;
  if (latestEl) latestEl.textContent = updateInfo.latestVersion;

  if (updateInfo.sessionsPreserved) {
    if (headerEl) headerEl.textContent = 'Quick Update';
    if (noteEl) {
      noteEl.textContent = 'Terminals stay connected';
      noteEl.classList.add('update-note-safe');
      noteEl.classList.remove('update-note-warning');
    }
  } else {
    if (headerEl) headerEl.textContent = 'Update Available';
    if (noteEl) {
      noteEl.textContent = 'Save your work - terminals will close';
      noteEl.classList.add('update-note-warning');
      noteEl.classList.remove('update-note-safe');
    }
  }
}

/**
 * Apply the available update and restart the server
 */
export function applyUpdate(): void {
  if (!updateInfo || !updateInfo.available) return;

  const panel = document.getElementById('update-panel');
  const btn = panel?.querySelector('.update-btn') as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating...';
  }

  fetch('/api/update/apply', { method: 'POST' })
    .then((r) => {
      if (r.ok) {
        if (btn) btn.textContent = 'Restarting...';
        waitForServerAndReload();
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Update & Restart';
        }
        console.error('Update failed');
      }
    })
    .catch((e) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Update & Restart';
      }
      console.error('Update error:', e);
    });
}

/**
 * Wait for the server to restart after an update, then reload the page
 */
export function waitForServerAndReload(): void {
  let attempts = 0;

  function checkServer(): void {
    attempts++;
    fetch('/api/version', { cache: 'no-store' })
      .then((r) => {
        if (r.ok) {
          location.reload();
        } else if (attempts < MAX_RELOAD_ATTEMPTS) {
          setTimeout(checkServer, RELOAD_INTERVAL_MS);
        }
      })
      .catch(() => {
        if (attempts < MAX_RELOAD_ATTEMPTS) {
          setTimeout(checkServer, RELOAD_INTERVAL_MS);
        }
      });
  }

  setTimeout(checkServer, INITIAL_RESTART_DELAY_MS);
}

/**
 * Manually check for updates and update the UI
 */
export function checkForUpdates(): void {
  const btn = document.getElementById('btn-check-updates') as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking...';
  }

  fetch('/api/update/check')
    .then((r) => r.json())
    .then((update: UpdateInfo) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Check for Updates';
      }

      setUpdateInfo(update);
      renderUpdatePanel();
      renderUpdateCards(update);
    })
    .catch((e) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Check for Updates';
      }
      renderUpdateCards(null, 'Failed to check for updates');
      console.error('Update check error:', e);
    });
}

/**
 * Render both GitHub and Local update cards
 */
function renderUpdateCards(update: UpdateInfo | null, error?: string): void {
  const container = document.getElementById('update-cards');
  const statusNone = document.getElementById('update-status-none');
  if (!container) return;

  container.innerHTML = '';

  // Error state
  if (error) {
    if (statusNone) statusNone.classList.add('hidden');
    container.innerHTML = `<div class="update-status-error">${error}</div>`;
    return;
  }

  const hasGitHub = update?.available ?? false;
  const hasLocal = update?.environment && update?.localUpdate?.available;

  // No updates available
  if (!hasGitHub && !hasLocal) {
    if (statusNone) statusNone.classList.remove('hidden');
    return;
  }

  if (statusNone) statusNone.classList.add('hidden');

  // GitHub update card
  if (hasGitHub && update) {
    const card = createUpdateCard({
      type: 'github',
      title: 'GitHub Release',
      version: update.latestVersion,
      sessionsPreserved: update.sessionsPreserved,
      onApply: applyUpdate
    });
    container.appendChild(card);
  }

  // Local update card (only in dev environment)
  if (hasLocal && update?.localUpdate) {
    const card = createUpdateCard({
      type: 'local',
      title: 'Local Build',
      version: update.localUpdate.version,
      sessionsPreserved: update.localUpdate.sessionsPreserved,
      onApply: applyLocalUpdate
    });
    container.appendChild(card);
  }
}

interface UpdateCardOptions {
  type: 'github' | 'local';
  title: string;
  version: string;
  sessionsPreserved: boolean;
  onApply: () => void;
}

/**
 * Create an update card element
 */
function createUpdateCard(opts: UpdateCardOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = `update-card ${opts.type}`;
  card.id = `update-card-${opts.type}`;

  const warningClass = opts.sessionsPreserved ? 'safe' : 'warn';
  const warningText = opts.sessionsPreserved
    ? 'Terminals stay connected'
    : 'Terminals will close';

  card.innerHTML = `
    <div class="update-card-header">
      <span class="update-card-title">${opts.title}</span>
      <span class="update-card-version">v${opts.version}</span>
    </div>
    <div class="update-card-footer">
      <span class="update-card-warning ${warningClass}">${warningText}</span>
      <button class="btn-update">Apply</button>
    </div>
  `;

  const btn = card.querySelector('.btn-update') as HTMLButtonElement;
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Applying...';
      opts.onApply();
    });
  }

  return card;
}

/**
 * Apply local update from C:\temp\mtlocalrelease
 */
export function applyLocalUpdate(): void {
  fetch('/api/update/apply?source=local', { method: 'POST' })
    .then((r) => {
      const btn = document.querySelector('#update-card-local .btn-update') as HTMLButtonElement | null;
      if (r.ok) {
        if (btn) btn.textContent = 'Restarting...';
        waitForServerAndReload();
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Apply';
        }
        console.error('Local update failed');
      }
    })
    .catch((e) => {
      const btn = document.querySelector('#update-card-local .btn-update') as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Apply';
      }
      console.error('Local update error:', e);
    });
}

/**
 * Handle incoming update info from WebSocket
 */
export function handleUpdateInfo(update: UpdateInfo): void {
  setUpdateInfo(update);
  renderUpdatePanel();
  renderUpdateCards(update);
}

interface UpdateResult {
  found: boolean;
  success: boolean;
  message: string;
  details: string;
  timestamp: string;
  logFile: string;
}

/**
 * Check for update results on startup and clear the result file.
 * The update result is shown in the settings panel, not as a notification.
 */
export function checkUpdateResult(): void {
  fetch('/api/update/result')
    .then((r) => r.json())
    .then((result: UpdateResult) => {
      if (!result.found) return;

      // Clear the result file - the result is shown in the settings/sidebar panels
      fetch('/api/update/result', { method: 'DELETE' }).catch((e) => {
        log.verbose(() => `Failed to clear update result: ${e}`);
      });
    })
    .catch((e) => log.warn(() => `Failed to check update result: ${e}`));
}
