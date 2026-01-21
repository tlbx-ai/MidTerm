/**
 * Version Check Utility
 *
 * Checks if the frontend JS version matches the server version.
 * Used on WebSocket reconnect to detect server updates.
 */

import { JS_BUILD_VERSION } from '../constants';
import { createLogger } from '../modules/logging';

const log = createLogger('version');

let updateBannerShown = false;

/**
 * Check if server version differs from frontend version.
 * If versions differ, shows a banner to let user refresh at their convenience.
 */
export async function checkVersionAndReload(): Promise<void> {
  if (updateBannerShown) return;

  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;

    const serverVersion = await response.text();
    if (serverVersion && serverVersion !== JS_BUILD_VERSION) {
      log.info(() => `Version mismatch: client=${JS_BUILD_VERSION}, server=${serverVersion}`);
      showUpdateBanner(serverVersion);
    }
  } catch {
    // Network error during version check - ignore, will retry on next reconnect
  }
}

/**
 * Show an update banner at the top of the screen.
 * User can click to refresh or dismiss.
 */
function showUpdateBanner(serverVersion: string): void {
  if (updateBannerShown) return;
  updateBannerShown = true;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';

  const message = document.createElement('span');
  message.textContent = `MidTerm updated to v${serverVersion}. Refresh to apply changes.`;

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh Now';
  refreshBtn.className = 'update-banner-btn';
  refreshBtn.onclick = () => location.reload();

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Later';
  dismissBtn.className = 'update-banner-dismiss';
  dismissBtn.onclick = () => {
    banner.remove();
  };

  banner.appendChild(message);
  banner.appendChild(refreshBtn);
  banner.appendChild(dismissBtn);

  document.body.appendChild(banner);
}
