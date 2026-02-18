/**
 * Version Check Utility
 *
 * Checks if the frontend JS version matches the server version.
 * Used on WebSocket reconnect to detect server updates.
 * Auto-reloads when a mismatch is detected.
 */

import { JS_BUILD_VERSION } from '../constants';
import { createLogger } from '../modules/logging';
import { getVersion } from '../api/client';

const log = createLogger('version');

let reloadTriggered = false;

/**
 * Check if server version differs from frontend version.
 * If versions differ, auto-reloads the page.
 */
export async function checkVersionAndReload(): Promise<void> {
  if (reloadTriggered) return;

  try {
    const { data, response } = await getVersion();
    if (!response.ok || !data) return;

    const serverVersion = data;
    if (serverVersion && serverVersion !== JS_BUILD_VERSION) {
      log.info(
        () => `Version mismatch: client=${JS_BUILD_VERSION}, server=${serverVersion} — reloading`,
      );
      reloadTriggered = true;
      location.reload();
    }
  } catch {
    // Network error during version check - ignore, will retry on next reconnect
  }
}
