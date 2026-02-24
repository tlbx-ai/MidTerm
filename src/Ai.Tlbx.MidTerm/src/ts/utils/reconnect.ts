/**
 * Reconnection Utilities
 *
 * Exponential backoff with jitter for WebSocket reconnection.
 */

import {
  RECONNECT_INITIAL_DELAY,
  RECONNECT_MAX_DELAY,
  RECONNECT_BACKOFF_FACTOR,
  RECONNECT_JITTER,
} from '../constants';

/**
 * Encapsulates reconnect state with exponential backoff and jitter.
 * Each WebSocket channel should create its own instance.
 */
export class ReconnectController {
  private _timer: number | undefined;
  private _attempt = 0;

  schedule(connect: () => void): void {
    this.cancel();
    const baseDelay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(RECONNECT_BACKOFF_FACTOR, this._attempt),
      RECONNECT_MAX_DELAY,
    );
    const jitter = baseDelay * RECONNECT_JITTER * (2 * Math.random() - 1);
    const delay = Math.round(baseDelay + jitter);
    this._timer = window.setTimeout(connect, delay);
    this._attempt++;
  }

  reset(): void {
    this._attempt = 0;
  }

  cancel(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}
