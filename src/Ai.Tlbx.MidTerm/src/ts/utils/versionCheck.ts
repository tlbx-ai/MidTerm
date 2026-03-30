/**
 * Version Check Utility
 *
 * Checks if the frontend JS version matches the server version.
 * Used on WebSocket reconnect to detect server updates and decide whether
 * the current shell can keep running until the user refreshes.
 */

import { JS_BUILD_VERSION, MUX_PROTOCOL_VERSION } from '../constants';
import { createLogger } from '../modules/logging';
import { getVersion, getVersionDetails } from '../api/client';
import {
  clearFrontendRefreshState,
  requestFrontendRefresh,
  setFrontendRefreshState,
} from '../modules/updating/runtime';

const log = createLogger('version');

let checkInFlight = false;

/**
 * Check if server version differs from frontend version and coordinate a safe
 * shell refresh policy for the current tab.
 */
export async function checkVersionAndReload(): Promise<void> {
  if (checkInFlight) return;
  checkInFlight = true;

  try {
    const [{ data, response }, detailsResult] = await Promise.all([
      getVersion(),
      getVersionDetails().catch(() => null),
    ]);
    if (!response.ok || !data) return;

    const serverVersion = data;
    if (!serverVersion || serverVersion === JS_BUILD_VERSION) {
      clearFrontendRefreshState();
      return;
    }

    const manifest = detailsResult?.data ?? null;
    const protocolCompatible =
      manifest?.protocol === undefined || manifest.protocol === MUX_PROTOCOL_VERSION;
    const webOnlyCompatible = manifest?.webOnly === true;
    const updateType: 'webOnly' | 'unknown' = manifest?.webOnly === true ? 'webOnly' : 'unknown';
    const refreshStatus = protocolCompatible && webOnlyCompatible ? 'available' : 'required';

    log.info(
      () =>
        `Version mismatch: client=${JS_BUILD_VERSION}, server=${serverVersion}, protocolCompatible=${String(protocolCompatible)}, webOnlyCompatible=${String(webOnlyCompatible)}`,
    );
    setFrontendRefreshState(serverVersion, { status: refreshStatus, updateType });

    if (!protocolCompatible) {
      requestFrontendRefresh();
    }
  } catch {
    // Network error during version check - ignore, will retry on next reconnect
  } finally {
    checkInFlight = false;
  }
}
