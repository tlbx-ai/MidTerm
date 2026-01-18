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
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10000;
    background: linear-gradient(135deg, #2d5a9e 0%, #1e3a5f 100%);
    color: white;
    padding: 10px 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 20px;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;

  const message = document.createElement('span');
  message.textContent = `MidTerm updated to v${serverVersion}. Refresh to apply changes.`;

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh Now';
  refreshBtn.style.cssText = `
    background: white;
    color: #1e3a5f;
    border: none;
    padding: 6px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  `;
  refreshBtn.onclick = () => location.reload();

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Later';
  dismissBtn.style.cssText = `
    background: transparent;
    color: white;
    border: 1px solid rgba(255,255,255,0.5);
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
  `;
  dismissBtn.onclick = () => {
    banner.remove();
    // Keep updateBannerShown true so we don't show again this session
  };

  banner.appendChild(message);
  banner.appendChild(refreshBtn);
  banner.appendChild(dismissBtn);

  document.body.appendChild(banner);
}
