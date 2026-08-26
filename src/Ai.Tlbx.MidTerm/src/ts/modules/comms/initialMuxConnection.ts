import { connectMuxWebSocket } from './muxChannel';
import { connectStateWebSocket, setInitialStateHydratedCallback } from './stateChannel';

const INITIAL_STATE_FAIL_OPEN_MS = 1500;

/**
 * Hydrate the session selection before opening the mux so the server can replay
 * the active terminal first. A bounded fallback keeps terminal I/O available if
 * the state channel is unusually slow or unavailable.
 */
export function connectInitialSessionTransports(): void {
  let muxConnected = false;
  let fallbackTimer: number | null = null;
  const connectMux = (): void => {
    if (muxConnected) return;
    muxConnected = true;
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    connectMuxWebSocket();
  };

  setInitialStateHydratedCallback(connectMux);
  connectStateWebSocket();
  fallbackTimer = window.setTimeout(connectMux, INITIAL_STATE_FAIL_OPEN_MS);
}
