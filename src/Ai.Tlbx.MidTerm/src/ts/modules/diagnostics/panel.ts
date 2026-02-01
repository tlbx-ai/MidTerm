/**
 * Diagnostics Panel Module
 *
 * Displays file paths, reload settings button, and latency measurements.
 */

import { getPaths, reloadSettings } from '../../api/client';
import { measureLatency } from '../comms/muxChannel';
import { $activeSessionId, getSession } from '../../stores';

let latencyInterval: ReturnType<typeof setInterval> | null = null;

export function initDiagnosticsPanel(): void {
  loadPaths();
  bindReloadSettingsButton();
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
  const label = session?.name || session?.shellType || sessionId;
  if (sessionEl) sessionEl.textContent = label;

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
