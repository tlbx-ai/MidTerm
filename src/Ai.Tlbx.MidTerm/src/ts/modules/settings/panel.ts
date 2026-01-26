/**
 * Settings Panel Module
 *
 * Handles the settings panel UI visibility, system status display,
 * and health check functionality.
 */

import type { HealthResponse } from '../../types';
import { sessionTerminals, dom } from '../../state';
import { $settingsOpen, $activeSessionId, $sessionList, $windowsBuildNumber } from '../../stores';
import { fetchSettings, unbindSettingsAutoSave } from './persistence';
import { initSettingsTabs } from './tabs';
import { createLogger } from '../logging';

const log = createLogger('settings');

/**
 * Close the mobile sidebar
 */
function closeSidebar(): void {
  const app = dom.app;
  if (app) app.classList.remove('sidebar-open');
}

/**
 * Toggle the settings panel visibility
 */
export function toggleSettings(): void {
  if ($settingsOpen.get()) {
    closeSettings();
  } else {
    openSettings();
  }
}

/**
 * Open the settings panel
 */
export function openSettings(): void {
  $settingsOpen.set(true);
  if (dom.settingsBtn) dom.settingsBtn.classList.add('active');
  closeSidebar();

  const activeId = $activeSessionId.get();
  if (activeId) {
    const state = sessionTerminals.get(activeId);
    if (state) state.container.classList.add('hidden');
  }

  if (dom.emptyState) dom.emptyState.classList.add('hidden');
  if (dom.settingsView) dom.settingsView.classList.remove('hidden');

  initSettingsTabs();
  fetchSettings();
  fetchSystemStatus();
  fetchCertificateInfo();
}

/**
 * Close the settings panel
 */
export function closeSettings(): void {
  unbindSettingsAutoSave();
  $settingsOpen.set(false);
  if (dom.settingsBtn) dom.settingsBtn.classList.remove('active');
  if (dom.settingsView) dom.settingsView.classList.add('hidden');

  const activeId = $activeSessionId.get();
  if (activeId) {
    const state = sessionTerminals.get(activeId);
    if (state) {
      state.container.classList.remove('hidden');
      requestAnimationFrame(() => {
        state.terminal.focus();
      });
    }
  } else if ($sessionList.get().length === 0 && dom.emptyState) {
    dom.emptyState.classList.remove('hidden');
  }
}

/**
 * Format uptime seconds into human-readable string
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (hours < 24) return hours + 'h ' + mins + 'm';

  const days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}

/**
 * Update the ttyhost version mismatch warning banner
 */
export function updateTtyHostWarning(health: HealthResponse): void {
  let banner = document.getElementById('ttyhost-warning');

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'ttyhost-warning';
    banner.className = 'warning-banner';
    const header = document.querySelector('.app-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    }
  }

  if (health.ttyHostVersion && health.ttyHostCompatible === false) {
    banner.innerHTML =
      '<strong>Version mismatch:</strong> mmttyhost is ' +
      health.ttyHostVersion +
      ', expected ' +
      health.ttyHostExpected +
      '. Terminals may not work correctly. Please update mmttyhost.exe or restart the service.';
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

/**
 * Fetch and display system status in the settings panel
 */
export function fetchSystemStatus(): void {
  const container = document.getElementById('system-status-content');
  if (!container) return;

  fetch('/api/health')
    .then((response) => response.json() as Promise<HealthResponse>)
    .then((health) => {
      const statusClass = health.healthy ? 'status-healthy' : 'status-error';
      const statusText = health.healthy ? 'Healthy' : 'Unhealthy';
      const uptimeStr = formatUptime(health.uptimeSeconds || 0);

      let ttyHostHtml = '';
      if (health.ttyHostVersion !== null && health.ttyHostVersion !== undefined) {
        const versionClass = health.ttyHostCompatible ? '' : 'status-error';
        ttyHostHtml =
          '<div class="status-detail-row">' +
          '<span class="detail-label">mmttyhost</span>' +
          '<span class="detail-value ' +
          versionClass +
          '">' +
          health.ttyHostVersion +
          (health.ttyHostCompatible ? '' : ' expected ' + health.ttyHostExpected) +
          '</span>' +
          '</div>';
      }

      container.innerHTML =
        '<div class="status-grid">' +
        '<div class="status-item">' +
        '<span class="status-label">Status</span>' +
        '<span class="status-value ' +
        statusClass +
        '">' +
        statusText +
        '</span>' +
        '</div>' +
        '<div class="status-item">' +
        '<span class="status-label">Mode</span>' +
        '<span class="status-value">' +
        (health.mode || '') +
        '</span>' +
        '</div>' +
        '<div class="status-item">' +
        '<span class="status-label">Sessions</span>' +
        '<span class="status-value">' +
        health.sessionCount +
        '</span>' +
        '</div>' +
        '<div class="status-item">' +
        '<span class="status-label">Uptime</span>' +
        '<span class="status-value">' +
        uptimeStr +
        '</span>' +
        '</div>' +
        '</div>' +
        '<div class="status-details">' +
        '<div class="status-detail-row">' +
        '<span class="detail-label">Platform</span>' +
        '<span class="detail-value">' +
        (health.platform || '') +
        '</span>' +
        '</div>' +
        '<div class="status-detail-row">' +
        '<span class="detail-label">Process ID</span>' +
        '<span class="detail-value">' +
        (health.webProcessId || '') +
        '</span>' +
        '</div>' +
        ttyHostHtml +
        '</div>';

      updateTtyHostWarning(health);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      container.innerHTML =
        '<div class="status-error-msg">Failed to load system status: ' + message + '</div>';
    });
}

/**
 * Check system health on startup for version mismatches
 */
export function checkSystemHealth(): void {
  fetch('/api/health')
    .then((response) => response.json() as Promise<HealthResponse>)
    .then((health) => {
      updateTtyHostWarning(health);
      if (health.windowsBuildNumber !== undefined) {
        $windowsBuildNumber.set(health.windowsBuildNumber);
      }
    })
    .catch((e) => log.warn(() => `Failed to check system health: ${e}`));
}

/**
 * Fetch and display certificate info in the Security settings tab
 */
export function fetchCertificateInfo(): void {
  const fingerprintEl = document.getElementById('settings-cert-fingerprint');
  const validityEl = document.getElementById('settings-cert-validity');

  if (!fingerprintEl && !validityEl) return;

  fetch('/api/certificate/share-packet')
    .then((response) => {
      if (!response.ok) throw new Error('Failed to fetch certificate info');
      return response.json();
    })
    .then((info) => {
      if (fingerprintEl) {
        fingerprintEl.textContent = info.certificate.fingerprintFormatted;
      }
      if (validityEl) {
        const notBefore = new Date(info.certificate.notBefore);
        const notAfter = new Date(info.certificate.notAfter);
        const dateOpts: Intl.DateTimeFormatOptions = {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        };
        validityEl.textContent =
          notBefore.toLocaleDateString(undefined, dateOpts) +
          ' - ' +
          notAfter.toLocaleDateString(undefined, dateOpts);
      }
    })
    .catch(() => {
      if (fingerprintEl) fingerprintEl.textContent = 'Error loading';
      if (validityEl) validityEl.textContent = '-';
    });
}
