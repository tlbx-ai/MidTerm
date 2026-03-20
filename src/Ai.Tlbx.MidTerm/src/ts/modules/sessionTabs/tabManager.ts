/**
 * Session Tab Manager
 *
 * Manages per-session tab state, creates/destroys session wrappers,
 * handles tab switching and terminal container reparenting.
 */

import { createLogger } from '../logging';
import type { SessionTabId, IdeBarActionId } from './tabBar';
import {
  createTabBar,
  isTabVisible,
  setActiveTab,
  setActionActive,
  setTabVisible,
  updateCwd,
  updateGitIndicator,
} from './tabBar';
import { $activeSessionId, $processStates, $sessionList } from '../../stores';
import { sessionTerminals } from '../../state';
import type { GitStatusResponse } from '../git/types';
import type { Session } from '../../types';

const log = createLogger('tabManager');

interface SessionTabState {
  wrapper: HTMLDivElement;
  tabBar: HTMLDivElement;
  panels: Record<SessionTabId, HTMLDivElement>;
  activeTab: SessionTabId;
  lensAvailable: boolean;
}

const sessionTabStates = new Map<string, SessionTabState>();

const tabActivationCallbacks: Partial<
  Record<SessionTabId, (sessionId: string, panel: HTMLDivElement) => void>
> = {};
const tabDeactivationCallbacks: Partial<Record<SessionTabId, (sessionId: string) => void>> = {};

function isInteractiveAgentProfile(profile: string | null | undefined): boolean {
  return (
    profile === 'codex' ||
    profile === 'claude' ||
    profile === 'open-code' ||
    profile === 'generic-ai'
  );
}

function shouldShowAgentTab(session: Session | null | undefined): boolean {
  return (
    session?.agentControlled === true || isInteractiveAgentProfile(session?.supervisor?.profile)
  );
}

export function onTabActivated(
  tab: SessionTabId,
  callback: (sessionId: string, panel: HTMLDivElement) => void,
): void {
  tabActivationCallbacks[tab] = callback;
}

export function onTabDeactivated(tab: SessionTabId, callback: (sessionId: string) => void): void {
  tabDeactivationCallbacks[tab] = callback;
}

export function ensureSessionWrapper(sessionId: string): SessionTabState {
  const existing = sessionTabStates.get(sessionId);
  if (existing) return existing;

  const wrapper = document.createElement('div');
  wrapper.className = 'session-wrapper';
  wrapper.dataset.sessionId = sessionId;

  const tabBar = createTabBar(sessionId, (tab) => {
    switchTab(sessionId, tab);
  });

  const panelsContainer = document.createElement('div');
  panelsContainer.className = 'session-tab-panels';

  const tabs: SessionTabId[] = ['terminal', 'agent', 'files'];
  const panels = {} as Record<SessionTabId, HTMLDivElement>;

  for (const tabId of tabs) {
    const panel = document.createElement('div');
    panel.className = 'session-tab-panel';
    if (tabId === 'terminal') panel.classList.add('active');
    panel.dataset.panel = tabId;

    if (tabId === 'agent') {
      panel.classList.add('agent-tab-panel');
    }

    if (tabId === 'files') {
      panel.innerHTML =
        '<div class="file-browser"><div class="file-browser-tree"></div><div class="file-browser-preview"></div></div>';
    }

    panels[tabId] = panel;
    panelsContainer.appendChild(panel);
  }

  wrapper.appendChild(tabBar);
  wrapper.appendChild(panelsContainer);

  const state: SessionTabState = {
    wrapper,
    tabBar,
    panels,
    activeTab: 'terminal',
    lensAvailable: false,
  };

  sessionTabStates.set(sessionId, state);

  const termState = sessionTerminals.get(sessionId);
  if (termState) {
    panels.terminal.appendChild(termState.container);
  }

  const processState = $processStates.get()[sessionId];
  if (processState?.foregroundCwd) {
    updateCwd(tabBar, processState.foregroundCwd);
  }

  syncSessionTabCapabilities(
    sessionId,
    $sessionList.get().find((session) => session.id === sessionId) ?? null,
  );

  return state;
}

export function destroySessionWrapper(sessionId: string): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;

  state.wrapper.remove();
  sessionTabStates.delete(sessionId);
}

export function getSessionWrapper(sessionId: string): HTMLDivElement | null {
  return sessionTabStates.get(sessionId)?.wrapper ?? null;
}

export function getTabPanel(sessionId: string, tab: SessionTabId): HTMLDivElement | null {
  return sessionTabStates.get(sessionId)?.panels[tab] ?? null;
}

export function getActiveTab(sessionId: string): SessionTabId {
  return sessionTabStates.get(sessionId)?.activeTab ?? 'terminal';
}

export function isTabAvailable(sessionId: string, tab: SessionTabId): boolean {
  const state = sessionTabStates.get(sessionId);
  if (!state) {
    return tab !== 'agent';
  }

  if (tab === 'agent') {
    return state.lensAvailable;
  }

  return isTabVisible(state.tabBar, tab);
}

export function syncSessionTabCapabilities(
  sessionId: string,
  session: Session | null | undefined,
): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) {
    return;
  }

  const showAgentTab = shouldShowAgentTab(session);
  state.lensAvailable = showAgentTab;
  setTabVisible(state.tabBar, 'agent', showAgentTab);

  if (!showAgentTab && state.activeTab === 'agent') {
    switchTab(sessionId, 'terminal');
  }
}

export function switchTab(
  sessionId: string,
  tab: SessionTabId,
  options?: { forceHidden?: boolean },
): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;
  if (tab === 'agent') {
    if (!state.lensAvailable) return;
  } else if (!options?.forceHidden && !isTabVisible(state.tabBar, tab)) {
    return;
  }

  const previousTab = state.activeTab;
  if (previousTab === tab) return;

  state.panels[previousTab].classList.remove('active');
  tabDeactivationCallbacks[previousTab]?.(sessionId);

  state.activeTab = tab;
  state.panels[tab].classList.add('active');
  setActiveTab(state.tabBar, tab);

  tabActivationCallbacks[tab]?.(sessionId, state.panels[tab]);

  if (tab === 'terminal') {
    const termState = sessionTerminals.get(sessionId);
    if (termState) {
      requestAnimationFrame(() => {
        termState.terminal.focus();
      });
    }
  }

  log.verbose(() => `Tab switched: ${sessionId} -> ${tab}`);
}

export function reparentTerminalContainer(sessionId: string, container: HTMLDivElement): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;
  state.panels.terminal.appendChild(container);
}

export function updateSessionCwd(sessionId: string, cwd: string): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;
  updateCwd(state.tabBar, cwd);
}

export function getTabBarHeight(): number {
  for (const state of sessionTabStates.values()) {
    if (state.wrapper.offsetParent !== null) {
      return state.tabBar.offsetHeight;
    }
  }
  return 0;
}

export function setActionButtonActive(actionId: IdeBarActionId, active: boolean): void {
  const activeSessionId = $activeSessionId.get();
  for (const [sessionId, state] of sessionTabStates.entries()) {
    setActionActive(state.tabBar, actionId, active && sessionId === activeSessionId);
  }
}

export function updateGitIndicatorForSession(
  sessionId: string,
  status: GitStatusResponse | null,
): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;
  updateGitIndicator(state.tabBar, status);
}

export function initSessionTabs(): void {
  $processStates.subscribe((states) => {
    for (const [sessionId, processState] of Object.entries(states)) {
      if (processState.foregroundCwd) {
        updateSessionCwd(sessionId, processState.foregroundCwd);
      }
    }
  });

  $sessionList.subscribe((sessions) => {
    for (const session of sessions) {
      syncSessionTabCapabilities(session.id, session);
    }
  });

  log.info(() => 'Session tabs initialized');
}
