/**
 * Settings Channel Module
 *
 * Manages the settings WebSocket connection for real-time settings and update sync.
 * When settings are changed on any client, all connected clients receive the update.
 */

import type { Settings, UpdateInfo } from '../../types';
import { scheduleReconnect } from '../../utils';
import { createLogger } from '../logging';
import { setCurrentSettings, setUpdateInfo } from '../../state';

const log = createLogger('settings-ws');

/** Message wrapper from server */
interface SettingsWsMessage {
  type: 'settings' | 'update';
  settings?: Settings;
  update?: UpdateInfo;
}

let settingsWs: WebSocket | null = null;
let settingsReconnectTimer: number | undefined;
let settingsWsConnected = false;

let applyReceivedSettings: (settings: Settings) => void = () => {};
let applyReceivedUpdate: (update: UpdateInfo) => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerSettingsCallbacks(callbacks: {
  applyReceivedSettings?: (settings: Settings) => void;
  applyReceivedUpdate?: (update: UpdateInfo) => void;
}): void {
  if (callbacks.applyReceivedSettings) applyReceivedSettings = callbacks.applyReceivedSettings;
  if (callbacks.applyReceivedUpdate) applyReceivedUpdate = callbacks.applyReceivedUpdate;
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
    settingsWsConnected = true;
    log.info(() => 'Settings WebSocket connected');
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as SettingsWsMessage;
      handleMessage(message);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(() => `Error parsing settings message: ${message}`);
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

function handleMessage(message: SettingsWsMessage): void {
  if (message.type === 'settings' && message.settings) {
    setCurrentSettings(message.settings);
    applyReceivedSettings(message.settings);
  } else if (message.type === 'update' && message.update) {
    setUpdateInfo(message.update);
    applyReceivedUpdate(message.update);
  }
}

function scheduleSettingsReconnect(): void {
  scheduleReconnect(
    connectSettingsWebSocket,
    (timer) => {
      settingsReconnectTimer = timer;
    },
    settingsReconnectTimer,
  );
}

export function isSettingsWsConnected(): boolean {
  return settingsWsConnected;
}
