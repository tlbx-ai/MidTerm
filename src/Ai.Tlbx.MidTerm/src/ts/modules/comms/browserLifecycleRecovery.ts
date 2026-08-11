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

export function setupBrowserLifecycleRecovery(options: BrowserLifecycleRecoveryOptions): void {
  let hiddenAtMs: number | null = isDocumentHidden() ? Date.now() : null;
  let forceTransportReconnect = false;
  let recoveryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let lastRecoveryAtMs = Number.NEGATIVE_INFINITY;

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
}

function isDocumentHidden(): boolean {
  return document.visibilityState === 'hidden';
}
