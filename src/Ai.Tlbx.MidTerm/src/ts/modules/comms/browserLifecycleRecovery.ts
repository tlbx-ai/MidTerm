import { $activeSessionId, $stateWsConnected } from '../../stores';
import { connectStateWebSocket, reportBrowserActivity } from './stateChannel';
import {
  recoverVisibleTerminalsAfterBrowserResume,
  suspendMuxForBrowserBackground,
} from './muxChannel';

interface BrowserLifecycleRecoveryOptions {
  getVisibleTerminalSessionIds: () => string[];
  syncMuxTerminalVisibility: () => void;
  focusActiveTerminal: () => void;
  applyScrollbackProtection: () => void;
  keepTerminalOutputActiveWhileHidden: () => boolean;
  reconnectSettingsAfterLongResume?: () => void;
}

const LONG_BACKGROUND_TRANSPORT_RESET_MS = 5000;
const FOREGROUND_RECOVERY_COALESCE_MS = 250;
const FOREGROUND_HEARTBEAT_INTERVAL_MS = 1000;

export function hasSuspendedForegroundEventLoop(
  lastHeartbeatAtMs: number,
  heartbeatAtMs: number,
): boolean {
  return heartbeatAtMs - lastHeartbeatAtMs >= LONG_BACKGROUND_TRANSPORT_RESET_MS;
}

export function setupBrowserLifecycleRecovery(
  options: BrowserLifecycleRecoveryOptions,
): () => void {
  let hiddenAtMs: number | null = isDocumentHidden() ? Date.now() : null;
  let forceTransportReconnect = false;
  let recoveryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let lastRecoveryAtMs = Number.NEGATIVE_INFINITY;
  let lastForegroundHeartbeatAtMs = Date.now();

  const recoverRealtimeAfterBrowserResume = (forceReconnect: boolean): void => {
    if (forceReconnect || !$stateWsConnected.get()) {
      connectStateWebSocket();
    } else {
      reportBrowserActivity(true);
    }

    if (forceReconnect) {
      options.reconnectSettingsAfterLongResume?.();
    }

    recoverVisibleTerminalsAfterBrowserResume(
      $activeSessionId.get(),
      options.getVisibleTerminalSessionIds(),
      { forceReconnect },
    );

    options.syncMuxTerminalVisibility();
    options.focusActiveTerminal();
    options.applyScrollbackProtection();
  };

  const cancelScheduledRecovery = (): void => {
    if (recoveryTimer === null) return;
    globalThis.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const rememberBackgroundStart = (): void => {
    hiddenAtMs ??= Date.now();
    cancelScheduledRecovery();
  };

  const scheduleForegroundRecovery = (): void => {
    const now = Date.now();
    lastForegroundHeartbeatAtMs = now;
    if (hiddenAtMs !== null) {
      forceTransportReconnect ||= now - hiddenAtMs >= LONG_BACKGROUND_TRANSPORT_RESET_MS;
      hiddenAtMs = null;
    }

    if (
      recoveryTimer === null &&
      !forceTransportReconnect &&
      now - lastRecoveryAtMs < FOREGROUND_RECOVERY_COALESCE_MS
    ) {
      return;
    }

    if (recoveryTimer !== null) return;
    recoveryTimer = globalThis.setTimeout(() => {
      recoveryTimer = null;
      if (isDocumentHidden()) {
        rememberBackgroundStart();
        return;
      }

      const shouldForceReconnect = forceTransportReconnect;
      forceTransportReconnect = false;
      lastRecoveryAtMs = Date.now();
      recoverRealtimeAfterBrowserResume(shouldForceReconnect);
    }, 0);
  };

  document.addEventListener('visibilitychange', () => {
    reportBrowserActivity();

    if (isDocumentHidden()) {
      rememberBackgroundStart();
      if (!options.keepTerminalOutputActiveWhileHidden()) {
        suspendMuxForBrowserBackground();
      }
      return;
    }

    scheduleForegroundRecovery();
  });

  window.addEventListener('focus', () => {
    scheduleForegroundRecovery();
  });

  window.addEventListener('blur', () => {
    rememberBackgroundStart();
    reportBrowserActivity(false);
  });

  window.addEventListener('pagehide', () => {
    rememberBackgroundStart();
    reportBrowserActivity(false);
  });

  window.addEventListener('pageshow', () => {
    scheduleForegroundRecovery();
  });

  document.addEventListener('resume', () => {
    scheduleForegroundRecovery();
  });

  document.addEventListener('freeze', () => {
    rememberBackgroundStart();
    reportBrowserActivity(false);
    if (!options.keepTerminalOutputActiveWhileHidden()) {
      suspendMuxForBrowserBackground();
    }
  });

  // Android may freeze a standalone PWA without reliably delivering every
  // visibility/focus event. A suspended event loop makes this lightweight
  // heartbeat arrive late; treat that gap exactly like a long background
  // interval instead of waiting for TCP/WebSocket timeouts.
  const heartbeatTimer = globalThis.setInterval(() => {
    const now = Date.now();
    const previousHeartbeatAtMs = lastForegroundHeartbeatAtMs;
    lastForegroundHeartbeatAtMs = now;

    if (isDocumentHidden()) {
      hiddenAtMs ??= now;
      return;
    }
    if (!hasSuspendedForegroundEventLoop(previousHeartbeatAtMs, now)) {
      return;
    }

    forceTransportReconnect = true;
    scheduleForegroundRecovery();
  }, FOREGROUND_HEARTBEAT_INTERVAL_MS);

  return () => {
    cancelScheduledRecovery();
    globalThis.clearInterval(heartbeatTimer);
  };
}

function isDocumentHidden(): boolean {
  return document.visibilityState === 'hidden';
}
