/**
 * Shared Session Module
 *
 * Detects shared-session routes, exchanges share link secrets for a scoped cookie,
 * and applies the reduced one-session UI mode.
 */

import {
  claimShareLink,
  getShareBootstrap,
  type ClaimShareResponse,
  type ShareBootstrapResponse,
} from '../../api/client';
import {
  $sharedAccessMode,
  $sharedExpiresAt,
  $sharedSessionId,
  $sharedSessionMode,
  $currentSettings,
  $serverHostname,
} from '../../stores';
import { dom } from '../../state';
import { applyCssTheme } from '../theming/cssThemes';
import { applySettingsToTerminals } from '../settings/persistence';
import { setLocale } from '../i18n';

export { initSessionShareButton } from './shareDialog';

export function isSharedSessionRoute(): boolean {
  return window.location.pathname === '/shared' || window.location.pathname.startsWith('/shared/');
}

export function getSharedGrantIdFromPath(): string | null {
  if (!isSharedSessionRoute()) {
    return null;
  }

  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

export async function claimSharedSessionAccess(): Promise<ClaimShareResponse> {
  const grantId = getSharedGrantIdFromPath();
  const secret = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!grantId || !secret) {
    throw new Error('Invalid shared session link');
  }

  const response = await claimShareLink({ grantId, secret });
  window.history.replaceState({}, document.title, window.location.pathname);
  return response;
}

export async function fetchSharedBootstrap(): Promise<ShareBootstrapResponse> {
  return getShareBootstrap();
}

export function applySharedSessionMode(bootstrap: ShareBootstrapResponse): void {
  $sharedSessionMode.set(true);
  $sharedSessionId.set(bootstrap.session?.id ?? null);
  $sharedAccessMode.set(bootstrap.mode);
  $sharedExpiresAt.set(bootstrap.expiresAtUtc);
  $serverHostname.set(bootstrap.hostname);
  $currentSettings.set(bootstrap.settings);

  document.body.classList.add('shared-session-mode');
  dom.app?.classList.add('shared-session-mode');
  applyCssTheme(bootstrap.settings.theme);
  applySettingsToTerminals(bootstrap.settings);
  void setLocale(bootstrap.settings.language);

  document.getElementById('settings-view')?.classList.add('hidden');
  document.getElementById('sidebar')?.classList.add('hidden');
  document.getElementById('voice-section')?.classList.add('hidden');
  document.getElementById('network-section')?.classList.add('hidden');
  document.getElementById('manager-bar')?.classList.add('hidden');
}

export function showSharedSessionError(message: string): void {
  document.body.classList.add('shared-session-mode');
  dom.app?.classList.add('shared-session-mode');
  const emptyState = document.getElementById('empty-state');
  const createBtn = document.getElementById('btn-create-terminal');
  const hint = emptyState?.querySelector('.empty-state-hint');
  const messageEl = emptyState?.querySelector('p');

  if (messageEl) {
    messageEl.textContent = message;
  }

  createBtn?.classList.add('hidden');
  hint?.classList.add('hidden');
  emptyState?.classList.remove('hidden');
}
