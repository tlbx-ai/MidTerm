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

function getCurrentDocumentAssetVersion(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const script = document.querySelector<HTMLScriptElement>('script[src*="/js/terminal.min.js"]');
  const src = script?.getAttribute('src')?.trim();
  if (!src) {
    return null;
  }

  try {
    const url = new URL(src, window.location.href);
    const value = url.searchParams.get('v')?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

function isSourceDevAssetVersion(assetVersion: string | null): boolean {
  return typeof assetVersion === 'string' && assetVersion.startsWith('dev-');
}

async function fetchServerAssetVersion(): Promise<string | null> {
  const response = await fetch('/index.html', { cache: 'no-store' });
  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const match = html.match(/\/js\/terminal\.min\.js\?v=([^"'\\s>]+)/i);
  const value = match?.[1]?.trim();
  return value ? decodeURIComponent(value) : null;
}

/**
 * Check if server version differs from frontend version and coordinate a safe
 * shell refresh policy for the current tab.
 */
export async function checkVersionAndReload(): Promise<void> {
  if (checkInFlight) return;
  checkInFlight = true;

  try {
    const currentAssetVersion = getCurrentDocumentAssetVersion();
    if (isSourceDevAssetVersion(currentAssetVersion)) {
      const serverAssetVersion = await fetchServerAssetVersion();
      if (serverAssetVersion && serverAssetVersion !== currentAssetVersion) {
        log.info(
          () =>
            `Source-dev asset mismatch: client=${currentAssetVersion}, server=${serverAssetVersion}`,
        );
        requestFrontendRefresh();
        return;
      }

      clearFrontendRefreshState();
      return;
    }

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
