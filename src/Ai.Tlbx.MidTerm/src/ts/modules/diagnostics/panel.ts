/**
 * Diagnostics Panel Module
 *
 * Displays file paths and reload settings button.
 */

interface PathsResponse {
  settingsFile: string;
  secretsFile: string;
  certificateFile: string;
  logDirectory: string;
}

export function initDiagnosticsPanel(): void {
  loadPaths();
  bindReloadSettingsButton();
}

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
