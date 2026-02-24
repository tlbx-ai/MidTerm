/**
 * Reconnection Utilities
 *
 * Simple fixed-interval reconnection logic for WebSocket connections.
 */

import { RECONNECT_DELAY } from '../constants';

/**
 * Schedule a reconnection after fixed delay.
 */
export function scheduleReconnect(
  connect: () => void,
  setTimer: (timer: number | undefined) => void,
  existingTimer: number | undefined,
): void {
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(connect, RECONNECT_DELAY);
  setTimer(timer);
}

/**
 * Encapsulates reconnection state for a single WebSocket connection.
 */
export class ReconnectController {
  private _timer: number | undefined;

  schedule(connect: () => void): void {
    scheduleReconnect(
      connect,
      (t) => {
        this._timer = t;
      },
      this._timer,
    );
  }

  reset(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
