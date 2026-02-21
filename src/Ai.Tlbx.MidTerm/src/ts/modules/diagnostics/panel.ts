/**
 * Diagnostics Panel Module
 *
 * Displays file paths, reload settings button, and latency measurements.
 */

import { getPaths, reloadSettings, restartServer } from '../../api/client';
import { measureLatency, onOutputRtt } from '../comms';
import { $activeSessionId, getSession } from '../../stores';
import { getSessionDisplayInfo } from '../sidebar/sessionList';
import { enableLatencyOverlay, disableLatencyOverlay } from './latencyOverlay';
import { enableGitStatusOverlay, disableGitStatusOverlay } from './gitStatusOverlay';
import { t } from '../i18n';

let latencyInterval: ReturnType<typeof setInterval> | null = null;

export function initDiagnosticsPanel(): void {
  loadPaths();
  bindReloadSettingsButton();
  bindRestartButton();
  bindOverlayToggle();
  bindGitOverlayToggle();
}

export function startLatencyMeasurement(): void {
  stopLatencyMeasurement();
  runLatencyPing();
  latencyInterval = setInterval(runLatencyPing, 2000);
}

export function stopLatencyMeasurement(): void {
  if (latencyInterval !== null) {
    clearInterval(latencyInterval);
    latencyInterval = null;
  }
}

async function runLatencyPing(): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  const sessionEl = document.getElementById('diag-ping-session');
  const serverEl = document.getElementById('diag-server-rtt');
  const mthostEl = document.getElementById('diag-mthost-rtt');

  const session = getSession(sessionId);
  if (sessionEl) {
    if (session) {
      const display = getSessionDisplayInfo(session);
      sessionEl.textContent = display.secondary
        ? `${display.primary} — ${display.secondary}`
        : display.primary;
    } else {
      sessionEl.textContent = sessionId;
    }
  }

  const result = await measureLatency(sessionId);

  if (serverEl) {
    serverEl.textContent =
      result.serverRtt !== null ? `${result.serverRtt.toFixed(1)} ms` : 'timeout';
  }
  if (mthostEl) {
    mthostEl.textContent =
      result.mthostRtt !== null ? `${result.mthostRtt.toFixed(1)} ms` : 'timeout';
  }
}

async function loadPaths(): Promise<void> {
  try {
    const { data, response } = await getPaths();
    if (!response.ok || !data) return;

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

function bindOverlayToggle(): void {
  const toggle = document.getElementById('diag-overlay-toggle') as HTMLInputElement | null;
  if (!toggle) return;

  const saved = localStorage.getItem('latency-overlay-enabled') === 'true';
  toggle.checked = saved;
  if (saved) {
    enableLatencyOverlay();
  }

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      enableLatencyOverlay();
      localStorage.setItem('latency-overlay-enabled', 'true');
    } else {
      disableLatencyOverlay();
      localStorage.removeItem('latency-overlay-enabled');
    }
  });

  const outputRttEl = document.getElementById('diag-output-rtt');
  if (outputRttEl) {
    onOutputRtt((_sessionId, rtt) => {
      outputRttEl.textContent = `${rtt.toFixed(1)} ms`;
    });
  }
}

function bindReloadSettingsButton(): void {
  const btn = document.getElementById('btn-reload-settings');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    try {
      const { response } = await reloadSettings();
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

function bindRestartButton(): void {
  const btn = document.getElementById('btn-restart-server') as HTMLButtonElement | null;
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const confirmed = confirm(t('settings.diagnostics.restartConfirm'));
    if (!confirmed) return;

    btn.disabled = true;

    try {
      await restartServer();
    } catch {
      // Server may have already shut down before responding — that's expected
    }

    showRestartOverlay();
  });
}

function showRestartOverlay(): void {
  const overlay = document.createElement('div');
  overlay.className = 'restart-overlay';
  overlay.innerHTML = `
    <div class="spinner"></div>
    <div>${t('settings.diagnostics.restartingServer')}</div>
  `;
  document.body.appendChild(overlay);

  let attempts = 0;
  const maxAttempts = 30; // 30 × 2s = 60s timeout

  const poll = setInterval(async () => {
    attempts++;
    try {
      const resp = await fetch('/api/health', { cache: 'no-store' });
      if (resp.ok) {
        clearInterval(poll);
        window.location.reload();
        return;
      }
    } catch {
      // Server still down — keep polling
    }

    if (attempts >= maxAttempts) {
      clearInterval(poll);
      overlay.innerHTML = `
        <div>${t('settings.diagnostics.restartFailed')}</div>
        <button class="btn-primary" onclick="window.location.reload()">${t('settings.diagnostics.retryConnection')}</button>
      `;
    }
  }, 2000);
}

function bindGitOverlayToggle(): void {
  const toggle = document.getElementById('diag-git-overlay-toggle') as HTMLInputElement | null;
  if (!toggle) return;

  const saved = localStorage.getItem('git-overlay-enabled') === 'true';
  toggle.checked = saved;
  if (saved) {
    enableGitStatusOverlay();
  }

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      enableGitStatusOverlay();
      localStorage.setItem('git-overlay-enabled', 'true');
    } else {
      disableGitStatusOverlay();
      localStorage.removeItem('git-overlay-enabled');
    }
  });
}
