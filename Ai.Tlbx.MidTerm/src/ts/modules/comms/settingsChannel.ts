/**
 * Settings Channel Module
 *
 * Manages the settings WebSocket connection for real-time settings sync.
 * When settings are changed on any client, all connected clients receive the update.
 */

import type { Settings } from '../../types';
import { INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY } from '../../constants';
import { scheduleReconnect } from '../../utils';
import { createLogger } from '../logging';
import { setCurrentSettings } from '../../state';

const log = createLogger('settings-ws');

let settingsWs: WebSocket | null = null;
let settingsReconnectTimer: number | undefined;
let settingsReconnectDelay = INITIAL_RECONNECT_DELAY;
let settingsWsConnected = false;

let applyReceivedSettings: (settings: Settings) => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerSettingsCallbacks(callbacks: {
  applyReceivedSettings?: (settings: Settings) => void;
}): void {
  if (callbacks.applyReceivedSettings) applyReceivedSettings = callbacks.applyReceivedSettings;
}

/**
 * Connect to the settings WebSocket for real-time settings sync.
 * Automatically reconnects with exponential backoff on disconnect.
 */
export function connectSettingsWebSocket(): void {
  if (settingsWs) {
    settingsWs.onclose = null;
    settingsWs.close();
    settingsWs = null;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/settings`);
  settingsWs = ws;

  ws.onopen = () => {
    settingsReconnectDelay = INITIAL_RECONNECT_DELAY;
    settingsWsConnected = true;
    log.info(() => 'Settings WebSocket connected');
  };

  ws.onmessage = (event) => {
    try {
      const settings = JSON.parse(event.data) as Settings;
      handleSettingsUpdate(settings);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(() => `Error parsing settings: ${message}`);
    }
  };

  ws.onclose = () => {
    settingsWsConnected = false;
    log.info(() => 'Settings WebSocket disconnected');
    scheduleSettingsReconnect();
  };

  ws.onerror = (e) => {
    log.error(() => `Settings WebSocket error: ${e}`);
  };
}

function handleSettingsUpdate(settings: Settings): void {
  setCurrentSettings(settings);
  applyReceivedSettings(settings);
}

function scheduleSettingsReconnect(): void {
  scheduleReconnect(
    settingsReconnectDelay,
    MAX_RECONNECT_DELAY,
    connectSettingsWebSocket,
    (delay) => { settingsReconnectDelay = delay; },
    (timer) => { settingsReconnectTimer = timer; },
    settingsReconnectTimer
  );
}

export function isSettingsWsConnected(): boolean {
  return settingsWsConnected;
}
