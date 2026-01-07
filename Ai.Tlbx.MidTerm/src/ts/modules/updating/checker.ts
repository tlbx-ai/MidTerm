/**
 * Update Checker Module
 *
 * Handles checking for updates, rendering the update panel,
 * and applying updates with server restart.
 */

import type { UpdateInfo } from '../../types';
import { updateInfo, setUpdateInfo } from '../../state';

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
      noteEl.textContent = 'Sessions will stay alive';
      noteEl.classList.add('update-note-safe');
      noteEl.classList.remove('update-note-warning');
    }
  } else {
    if (headerEl) headerEl.textContent = 'Update Available';
    if (noteEl) {
      noteEl.textContent = 'Save your work - sessions will restart';
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
  const statusEl = document.getElementById('update-status');
  const warningEl = document.getElementById('update-warning');

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
      renderLocalUpdateSection(update);

      const applyBtn = document.getElementById('btn-apply-update');
      if (statusEl) {
        statusEl.classList.remove('hidden');
        if (update && update.available) {
          statusEl.className = 'update-status update-status-available';
          statusEl.textContent = 'Update available: v' + update.latestVersion;
          if (applyBtn) applyBtn.classList.remove('hidden');

          // Show warning based on session preservation
          if (warningEl) {
            warningEl.classList.remove('hidden');
            if (update.sessionsPreserved) {
              warningEl.textContent = 'Sessions will stay alive';
              warningEl.className = 'update-warning update-warning-safe';
            } else {
              warningEl.textContent = 'Save your work - sessions will restart';
              warningEl.className = 'update-warning update-warning-warn';
            }
          }
        } else {
          statusEl.className = 'update-status update-status-current';
          statusEl.textContent = 'You are running the latest version';
          if (applyBtn) applyBtn.classList.add('hidden');
          if (warningEl) warningEl.classList.add('hidden');
        }
      }
    })
    .catch((e) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Check for Updates';
      }
      if (statusEl) {
        statusEl.classList.remove('hidden');
        statusEl.className = 'update-status update-status-error';
        statusEl.textContent = 'Failed to check for updates';
      }
      if (warningEl) warningEl.classList.add('hidden');
      console.error('Update check error:', e);
    });
}

/**
 * Render local update section (only visible in dev environment)
 */
export function renderLocalUpdateSection(update: UpdateInfo | null): void {
  let section = document.getElementById('local-update-section');

  // Remove section if not in dev environment
  if (!update?.environment) {
    if (section) section.remove();
    return;
  }

  // Create section if it doesn't exist
  if (!section) {
    section = createLocalUpdateSection();
    const warningEl = document.getElementById('update-warning');
    if (warningEl) {
      warningEl.after(section);
    }
  }

  const statusEl = section.querySelector('.local-update-status');
  const applyBtn = section.querySelector('.btn-apply-local') as HTMLButtonElement | null;
  const warningEl = section.querySelector('.local-update-warning');
  const local = update.localUpdate;

  if (statusEl) {
    if (local?.available) {
      statusEl.textContent = `Local build available: v${local.version}`;
      statusEl.className = 'local-update-status local-update-available';
      if (applyBtn) {
        applyBtn.classList.remove('hidden');
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Local Build';
      }
      if (warningEl) {
        warningEl.classList.remove('hidden');
        if (local.sessionsPreserved) {
          warningEl.textContent = 'Sessions will stay alive';
          warningEl.className = 'local-update-warning local-warning-safe';
        } else {
          warningEl.textContent = 'Save your work - sessions will restart';
          warningEl.className = 'local-update-warning local-warning-warn';
        }
      }
    } else {
      statusEl.textContent = 'No local build available';
      statusEl.className = 'local-update-status';
      if (applyBtn) applyBtn.classList.add('hidden');
      if (warningEl) warningEl.classList.add('hidden');
    }
  }
}

/**
 * Create the local update section HTML
 */
function createLocalUpdateSection(): HTMLElement {
  const section = document.createElement('div');
  section.id = 'local-update-section';
  section.className = 'local-update-section';
  section.innerHTML = `
    <div class="local-update-header">Local Development</div>
    <div class="local-update-status"></div>
    <button class="btn-dev btn-apply-local hidden">Apply Local Build</button>
    <div class="local-update-warning hidden"></div>
  `;

  const applyBtn = section.querySelector('.btn-apply-local');
  if (applyBtn) {
    applyBtn.addEventListener('click', applyLocalUpdate);
  }

  return section;
}

/**
 * Apply local update from C:\temp\mtlocalrelease
 */
export function applyLocalUpdate(): void {
  const section = document.getElementById('local-update-section');
  const btn = section?.querySelector('.btn-apply-local') as HTMLButtonElement | null;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Applying...';
  }

  fetch('/api/update/apply?source=local', { method: 'POST' })
    .then((r) => {
      if (r.ok) {
        if (btn) btn.textContent = 'Restarting...';
        waitForServerAndReload();
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Apply Local Build';
        }
        console.error('Local update failed');
      }
    })
    .catch((e) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Apply Local Build';
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
      fetch('/api/update/result', { method: 'DELETE' }).catch(() => {});
    })
    .catch(() => {});
}
