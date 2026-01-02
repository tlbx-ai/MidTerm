/**
 * MiddleManager Terminal Client
 *
 * Web-based terminal multiplexer frontend using xterm.js.
 * Main entry point - wires together all modules.
 */

import { initThemeFromCookie } from './modules/theming';
import {
  connectStateWebSocket,
  connectMuxWebSocket,
  registerStateCallbacks,
  registerMuxCallbacks,
  sendInput,
  sendResize
} from './modules/comms';
import {
  createTerminalForSession,
  destroyTerminalForSession,
  applySettingsToTerminals,
  refreshActiveTerminalBuffer,
  preloadTerminalFont,
  registerTerminalCallbacks,
  applyTerminalScaling,
  fitSessionToScreen,
  setupResizeObserver,
  setupVisualViewport,
  registerScalingCallbacks,
  bindSearchEvents
} from './modules/terminal';
import {
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
  getSessionDisplayName,
  setSessionListCallbacks,
  toggleSidebar,
  closeSidebar,
  collapseSidebar,
  expandSidebar,
  restoreSidebarState,
  setupSidebarResize
} from './modules/sidebar';
import {
  openSettings,
  closeSettings,
  toggleSettings,
  checkSystemHealth,
  fetchSettings
} from './modules/settings';
import {
  checkAuthStatus,
  bindAuthEvents
} from './modules/auth';
import {
  renderUpdatePanel,
  applyUpdate,
  checkForUpdates,
  showChangelog,
  closeChangelog
} from './modules/updating';
import {
  cacheDOMElements,
  sessions,
  activeSessionId,
  sessionTerminals,
  currentSettings,
  settingsOpen,
  stateWsConnected,
  muxWsConnected,
  stateReconnectDelay,
  muxReconnectDelay,
  dom,
  setActiveSessionId,
  setFontsReadyPromise,
  newlyCreatedSessions,
  pendingSessions
} from './state';
import { bindClick, escapeHtml } from './utils';

// Debug export for console access
(window as any).mmDebug = {
  get terminals() { return sessionTerminals; },
  get activeId() { return activeSessionId; },
  get settings() { return currentSettings; }
};

// =============================================================================
// Initialization
// =============================================================================

initThemeFromCookie();

document.addEventListener('DOMContentLoaded', init);

function init(): void {
  cacheDOMElements();
  restoreSidebarState();
  setupSidebarResize();

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);

  registerCallbacks();
  connectStateWebSocket();
  connectMuxWebSocket();
  checkSystemHealth();

  bindEvents();
  bindAuthEvents();
  bindSearchEvents();
  setupResizeObserver();
  setupVisualViewport();

  fetchVersion();
  fetchNetworks();
  fetchSettings();
  checkAuthStatus();
  requestNotificationPermission();

  setupVisibilityChangeHandler();
}

// =============================================================================
// Callback Registration
// =============================================================================

function registerCallbacks(): void {
  registerStateCallbacks({
    destroyTerminalForSession,
    applyTerminalScaling,
    renderSessionList,
    updateEmptyState,
    selectSession,
    updateMobileTitle,
    renderUpdatePanel
  });

  registerMuxCallbacks({
    applyTerminalScaling,
    refreshActiveTerminalBuffer
  });

  registerTerminalCallbacks({
    sendInput,
    showBellNotification
  });

  registerScalingCallbacks({
    sendResize: (sessionId: string, terminal: { cols: number; rows: number }) => {
      sendResize(sessionId, terminal.cols, terminal.rows);
    }
  });

  setSessionListCallbacks({
    onSelect: selectSession,
    onDelete: deleteSession,
    onRename: startInlineRename,
    onResize: fitSessionToScreen,
    onCloseSidebar: closeSidebar
  });
}

// =============================================================================
// Visibility Change Handler
// =============================================================================

function setupVisibilityChangeHandler(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!stateWsConnected) {
        connectStateWebSocket();
      }
      if (!muxWsConnected) {
        connectMuxWebSocket();
      }
      if (muxWsConnected && activeSessionId) {
        setTimeout(refreshActiveTerminalBuffer, 200);
      }
    }
  });
}

// =============================================================================
// Session Management
// =============================================================================

function createSession(): void {
  const rect = dom.terminalsArea?.getBoundingClientRect();
  let cols = currentSettings?.defaultCols ?? 120;
  let rows = currentSettings?.defaultRows ?? 30;

  if (rect && rect.width > 100 && rect.height > 100) {
    const fontSize = currentSettings?.fontSize ?? 14;
    const charWidth = fontSize * 0.6;
    const lineHeight = fontSize * 1.2;
    const padding = 8;

    const availWidth = rect.width - padding;
    const availHeight = rect.height - padding;

    const measuredCols = Math.floor(availWidth / charWidth);
    const measuredRows = Math.floor(availHeight / lineHeight);

    if (measuredCols > 10 && measuredRows > 5) {
      cols = Math.min(measuredCols, 300);
      rows = Math.min(measuredRows, 100);
    }
  }

  // Optimistic UI: add temporary session with spinner
  const tempId = 'pending-' + Date.now();
  const tempSession = {
    id: tempId,
    name: null,
    shellType: 'Loading...',
    cols: cols,
    rows: rows
  };
  sessions.push(tempSession);
  pendingSessions.add(tempId);
  renderSessionList();
  closeSidebar();

  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Cols: cols, Rows: rows })
  })
    .then((r) => r.json())
    .then((session) => {
      // Remove temporary session
      pendingSessions.delete(tempId);
      const idx = sessions.findIndex((s) => s.id === tempId);
      if (idx >= 0) {
        sessions.splice(idx, 1);
      }

      newlyCreatedSessions.add(session.id);
      selectSession(session.id);
    })
    .catch((e) => {
      // Remove temporary session on error
      pendingSessions.delete(tempId);
      const idx = sessions.findIndex((s) => s.id === tempId);
      if (idx >= 0) {
        sessions.splice(idx, 1);
        renderSessionList();
        updateEmptyState();
      }
      console.error('Error creating session:', e);
    });
}

function selectSession(sessionId: string): void {
  if (settingsOpen) {
    closeSettings();
  }

  sessionTerminals.forEach((state) => {
    state.container.classList.add('hidden');
  });

  setActiveSessionId(sessionId);

  const sessionInfo = sessions.find((s) => s.id === sessionId);
  const state = createTerminalForSession(sessionId, sessionInfo);
  const isNewTerminal = state.serverCols === 0;
  const isNewlyCreated = newlyCreatedSessions.has(sessionId);
  state.container.classList.remove('hidden');

  requestAnimationFrame(() => {
    state.terminal.focus();

    if (isNewTerminal && !isNewlyCreated) {
      import('./modules/terminal').then((mod) => {
        mod.fetchAndWriteBuffer(sessionId, state.terminal);
      });
    }

    if (isNewlyCreated) {
      newlyCreatedSessions.delete(sessionId);
    }
  });

  renderSessionList();
  updateMobileTitle();
  dom.emptyState?.classList.add('hidden');
}

function deleteSession(sessionId: string): void {
  // Optimistic UI: remove session immediately for better UX
  destroyTerminalForSession(sessionId);

  // Remove from local sessions array
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx >= 0) {
    sessions.splice(idx, 1);
  }

  // If this was the active session, select another
  if (activeSessionId === sessionId) {
    setActiveSessionId(null);
    if (sessions.length > 0) {
      selectSession(sessions[0].id);
    }
  }

  renderSessionList();
  updateEmptyState();
  updateMobileTitle();

  // Send delete request to server
  fetch('/api/sessions/' + sessionId, { method: 'DELETE' }).catch((e) => {
    console.error('Error deleting session:', e);
  });
}

function renameSession(sessionId: string, newName: string | null): void {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const trimmedName = (newName || '').trim();
  const nameToSend = trimmedName === '' || trimmedName === session.shellType ? null : trimmedName;

  fetch('/api/sessions/' + sessionId + '/name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameToSend })
  })
    .then(() => {
      session.manuallyNamed = true;
    })
    .catch((e) => {
      console.error('Error renaming session:', e);
    });
}

function startInlineRename(sessionId: string): void {
  const item = dom.sessionList?.querySelector(`[data-session-id="${sessionId}"]`);
  if (!item) return;

  const titleSpan = item.querySelector('.session-title');
  if (!titleSpan) return;

  const session = sessions.find((s) => s.id === sessionId);
  const currentName = session ? (session.name || session.shellType) : '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentName;

  function finishRename(): void {
    renameSession(sessionId, input.value);
    input.replaceWith(titleSpan);
  }

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.replaceWith(titleSpan);
    }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}

function promptRenameSession(sessionId: string): void {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const currentName = session.name || session.shellType;
  const newName = prompt('Rename terminal:', currentName);

  if (newName !== null) {
    renameSession(sessionId, newName);
  }
}

// =============================================================================
// Notifications
// =============================================================================

function requestNotificationPermission(): void {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function showBellNotification(sessionId: string): void {
  if (!currentSettings) return;

  const bellStyle = currentSettings.bellStyle || 'notification';
  const session = sessions.find((s) => s.id === sessionId);
  const title = session ? getSessionDisplayName(session) : 'Terminal';

  if ((bellStyle === 'notification' || bellStyle === 'both') &&
      Notification.permission === 'granted' && document.hidden) {
    new Notification('Bell: ' + title, {
      body: 'Terminal bell triggered',
      icon: '/favicon.ico'
    });
  }

  if (bellStyle === 'visual' || bellStyle === 'both') {
    const state = sessionTerminals.get(sessionId);
    if (state) {
      state.container.classList.add('bell-flash');
      setTimeout(() => {
        state.container.classList.remove('bell-flash');
      }, 200);
    }
  }
}

// =============================================================================
// API Helpers
// =============================================================================

function fetchVersion(): void {
  fetch('/api/version')
    .then((r) => r.text())
    .then((v) => {
      const shortVersion = v.split(/[+-]/)[0].split('.').slice(0, 3).join('.');
      const el = document.getElementById('app-version');
      if (el) el.textContent = 'v' + shortVersion;
    })
    .catch(() => {});
}

function fetchNetworks(): void {
  fetch('/api/networks')
    .then((r) => r.json())
    .then((networks) => {
      const list = document.getElementById('network-list');
      if (!list) return;

      list.innerHTML = networks.map((n: { name: string; ip: string }) => {
        return '<div class="network-item">' +
          '<span class="network-name" title="' + escapeHtml(n.name) + '">' +
          escapeHtml(n.name) + '</span>' +
          '<span class="network-ip">' + escapeHtml(n.ip) + ':' + location.port + '</span>' +
          '</div>';
      }).join('');
    })
    .catch(() => {});
}

// =============================================================================
// Event Binding
// =============================================================================

function bindEvents(): void {
  bindClick('btn-new-session', createSession);
  bindClick('btn-new-session-mobile', createSession);
  bindClick('btn-create-terminal', createSession);

  bindClick('btn-hamburger', toggleSidebar);
  bindClick('btn-collapse-sidebar', collapseSidebar);
  bindClick('btn-expand-sidebar', expandSidebar);

  if (dom.sidebarOverlay) {
    dom.sidebarOverlay.addEventListener('click', closeSidebar);
  }

  bindClick('btn-ctrlc-mobile', () => {
    if (activeSessionId) sendInput(activeSessionId, '\x03');
  });
  bindClick('btn-resize-mobile', () => {
    if (activeSessionId) fitSessionToScreen(activeSessionId);
  });
  bindClick('btn-rename-mobile', () => {
    if (activeSessionId) promptRenameSession(activeSessionId);
  });
  bindClick('btn-close-mobile', () => {
    if (activeSessionId) deleteSession(activeSessionId);
  });

  if (dom.settingsBtn) {
    dom.settingsBtn.addEventListener('click', toggleSettings);
  }

  bindClick('update-btn', applyUpdate);
  bindClick('btn-check-updates', checkForUpdates);
  bindClick('btn-apply-update', applyUpdate);
  bindClick('btn-show-changelog', showChangelog);
  bindClick('btn-close-changelog', closeChangelog);

  const changelogBackdrop = document.querySelector('#changelog-modal .modal-backdrop');
  if (changelogBackdrop) {
    changelogBackdrop.addEventListener('click', closeChangelog);
  }

  import('./modules/settings').then((mod) => {
    mod.bindSettingsAutoSave();
  });
}
