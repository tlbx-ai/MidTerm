/**
 * Auth Status Module
 *
 * Handles authentication status checking and security warning display.
 */

import { getAuthStatus, logout as apiLogout } from '../../api/client';
import { $authStatus } from '../../stores';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('auth');

/**
 * Check authentication status from server
 */
export async function checkAuthStatus(): Promise<void> {
  try {
    const { data, response } = await getAuthStatus();

    if (response.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    if (data) {
      $authStatus.set({
        authenticationEnabled: data.authenticationEnabled,
        passwordSet: data.passwordSet,
      });
    }
    updateSecurityWarning();
    updatePasswordStatus();
  } catch (e) {
    log.error(() => `Auth status error: ${String(e)}`);
  }
}

/**
 * Update security warning visibility based on auth status
 */
export function updateSecurityWarning(): void {
  const warning = document.getElementById('security-warning');
  if (!warning) return;

  const status = $authStatus.get();
  if (status && status.authenticationEnabled && !status.passwordSet) {
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }
}

/**
 * Update password status text in settings panel
 */
export function updatePasswordStatus(): void {
  const statusEl = document.getElementById('password-status-text');
  if (!statusEl) return;

  const status = $authStatus.get();
  if (!status) {
    statusEl.textContent = t('settings.security.checking');
    statusEl.className = '';
    return;
  }

  if (status.passwordSet) {
    statusEl.textContent = t('settings.security.passwordSet');
    statusEl.className = 'status-set';
  } else {
    statusEl.textContent = t('settings.security.noPasswordSet');
    statusEl.className = 'status-missing';
  }
}

/**
 * Dismiss the security warning banner
 */
export function dismissSecurityWarning(): void {
  const warning = document.getElementById('security-warning');
  if (warning) {
    warning.classList.add('hidden');
  }
}

/**
 * Logout: clear session and redirect to login page
 */
export async function logout(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // Ignore errors - we're logging out anyway
  }
  window.location.href = '/login';
}
