/**
 * Session Tab Manager
 *
 * Manages per-session tab state, creates/destroys session wrappers,
 * handles tab switching and terminal container reparenting.
 */

import { createLogger } from '../logging';
import type { SessionTabId } from './tabBar';
import { createTabBar, setActiveTab, updateCwd } from './tabBar';
import { $processStates } from '../../stores';
import { sessionTerminals } from '../../state';

const log = createLogger('tabManager');

interface SessionTabState {
  wrapper: HTMLDivElement;
  tabBar: HTMLDivElement;
  panels: Record<SessionTabId, HTMLDivElement>;
  activeTab: SessionTabId;
}

const sessionTabStates = new Map<string, SessionTabState>();

const tabActivationCallbacks: Partial<
  Record<SessionTabId, (sessionId: string, panel: HTMLDivElement) => void>
> = {};
const tabDeactivationCallbacks: Partial<Record<SessionTabId, (sessionId: string) => void>> = {};

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

  const tabBar = createTabBar(sessionId, (tab) => switchTab(sessionId, tab));

  const panelsContainer = document.createElement('div');
  panelsContainer.className = 'session-tab-panels';

  const tabs: SessionTabId[] = ['terminal', 'files', 'git', 'commands'];
  const panels = {} as Record<SessionTabId, HTMLDivElement>;

  for (const tabId of tabs) {
    const panel = document.createElement('div');
    panel.className = 'session-tab-panel';
    if (tabId === 'terminal') panel.classList.add('active');
    panel.dataset.panel = tabId;

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
  };

  sessionTabStates.set(sessionId, state);

  const termState = sessionTerminals.get(sessionId);
  if (termState) {
    panels.terminal.appendChild(termState.container);
  }

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

export function switchTab(sessionId: string, tab: SessionTabId): void {
  const state = sessionTabStates.get(sessionId);
  if (!state) return;

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

export function initSessionTabs(): void {
  $processStates.subscribe((states) => {
    for (const [sessionId, processState] of Object.entries(states)) {
      if (processState.foregroundCwd) {
        updateSessionCwd(sessionId, processState.foregroundCwd);
      }
    }
  });

  log.info(() => 'Session tabs initialized');
}
