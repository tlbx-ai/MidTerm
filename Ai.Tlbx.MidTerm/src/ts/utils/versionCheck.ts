/**
 * Version Check Utility
 *
 * Checks if the frontend JS version matches the server version.
 * Used on WebSocket reconnect to detect server updates.
 */

import { JS_BUILD_VERSION } from '../constants';
import { createLogger } from '../modules/logging';

const log = createLogger('version');

/**
 * Check if server version differs from frontend version.
 * If versions differ, reloads the page to get updated assets.
 */
export async function checkVersionAndReload(): Promise<void> {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' });
    if (!response.ok) return;

    const serverVersion = await response.text();
    if (serverVersion && serverVersion !== JS_BUILD_VERSION) {
      log.info(
        () => `Version mismatch: client=${JS_BUILD_VERSION}, server=${serverVersion} - reloading`,
      );
      location.reload();
    }
  } catch {
    // Network error during version check - ignore, will retry on next reconnect
  }
}
