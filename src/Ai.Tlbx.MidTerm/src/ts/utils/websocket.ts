/**
 * WebSocket Utilities
 *
 * Helper functions for WebSocket connection management.
 */

import { getOrCreateTabId } from './cookies';

/**
 * Create WebSocket URL with correct protocol (ws/wss based on page protocol)
 */
export function createWsUrl(path: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${location.host}${path}`);
  url.searchParams.set('tabId', getOrCreateTabId());
  return url.toString();
}

/**
 * Close WebSocket cleanly, preventing reconnect loops.
 * Sets onclose to null before closing to prevent the close handler from triggering.
 */
export function closeWebSocket(ws: WebSocket | null, setter?: (ws: null) => void): void {
  if (ws) {
    ws.onclose = null;
    ws.close();
    if (setter) setter(null);
  }
}
