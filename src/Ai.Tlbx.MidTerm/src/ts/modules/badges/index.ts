/**
 * Badges Module
 *
 * Manages global status badges (connection, paste indicator, data loss warning).
 * Per-terminal badges (scaled view) remain in their respective modules.
 */

import { $connectionStatus, $dataLossDetected, getSession } from '../../stores';
import { getSessionDisplayName } from '../sidebar/sessionList';
import { t } from '../i18n';

let connectionBadge: HTMLElement | null = null;
let pasteBadge: HTMLElement | null = null;
let dataLossBadge: HTMLElement | null = null;
let dataLossTimer: number | null = null;

const DATA_LOSS_DISPLAY_MS = 10000;

/**
 * Initialize all global badges. Call once during bootstrap.
 */
export function initBadges(): void {
  connectionBadge = document.getElementById('connection-status');
  pasteBadge = document.getElementById('paste-indicator');
  dataLossBadge = document.getElementById('data-loss-warning');

  $connectionStatus.subscribe((status) => {
    if (!connectionBadge) return;

    const text =
      status === 'connected'
        ? ''
        : status === 'disconnected'
          ? 'Server disconnected'
          : 'Reconnecting...';

    connectionBadge.className = `status-badge connection-status ${status}`;
    connectionBadge.textContent = text;
  });

  $dataLossDetected.subscribe((loss) => {
    if (!loss) {
      hideDataLossWarning();
      return;
    }
    showDataLossWarning(loss.sessionId);
  });
}

/**
 * Show data loss warning badge.
 */
function showDataLossWarning(sessionId: string): void {
  if (!dataLossBadge) return;

  const session = getSession(sessionId);
  const name = session ? getSessionDisplayName(session) : sessionId;
  dataLossBadge.textContent = `⚠ ${t('badges.overflow')} (${name})`;
  dataLossBadge.classList.add('active');

  // Clear any existing timer
  if (dataLossTimer !== null) {
    window.clearTimeout(dataLossTimer);
  }

  // Auto-hide after timeout
  dataLossTimer = window.setTimeout(() => {
    hideDataLossWarning();
    $dataLossDetected.set(null);
  }, DATA_LOSS_DISPLAY_MS);
}

/**
 * Hide data loss warning badge.
 */
function hideDataLossWarning(): void {
  if (dataLossBadge) {
    dataLossBadge.classList.remove('active');
  }
  if (dataLossTimer !== null) {
    window.clearTimeout(dataLossTimer);
    dataLossTimer = null;
  }
}

/**
 * Show the paste indicator badge.
 */
export function showPasteIndicator(): void {
  if (pasteBadge) {
    pasteBadge.textContent = t('badges.pasting');
    pasteBadge.classList.add('active');
  }
}

/**
 * Hide the paste indicator badge.
 */
export function hidePasteIndicator(): void {
  if (pasteBadge) {
    pasteBadge.classList.remove('active');
  }
}
