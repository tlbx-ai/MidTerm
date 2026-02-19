/**
 * Session Tab Bar
 *
 * Creates and manages the tab bar UI for each session.
 * Tabs: Terminal | Files
 * Right-aligned actions: Commands (⚡) | Git status indicator
 */

import type { GitStatusResponse } from '../git/types';
import { t } from '../i18n';

export type SessionTabId = 'terminal' | 'files';

export type IdeBarActionId = 'git' | 'commands' | 'web';

function getTabLabels(): Record<SessionTabId, string> {
  return {
    terminal: t('session.terminal'),
    files: t('modal.file'),
  };
}

let commandsClickHandler: (() => void) | null = null;
let gitClickHandler: (() => void) | null = null;
let webClickHandler: (() => void) | null = null;

export function setCommandsClickHandler(handler: () => void): void {
  commandsClickHandler = handler;
}

export function setGitClickHandler(handler: () => void): void {
  gitClickHandler = handler;
}

export function setWebClickHandler(handler: () => void): void {
  webClickHandler = handler;
}

export function createTabBar(
  sessionId: string,
  onTabSelect: (tab: SessionTabId) => void,
): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'session-tab-bar';
  bar.dataset.sessionId = sessionId;

  const cwdSpan = document.createElement('span');
  cwdSpan.className = 'session-cwd';
  bar.appendChild(cwdSpan);

  for (const [tabId, label] of Object.entries(getTabLabels())) {
    const btn = document.createElement('button');
    btn.className = 'session-tab';
    if (tabId === 'terminal') btn.classList.add('active');
    btn.dataset.tab = tabId;
    btn.textContent = label;
    btn.addEventListener('click', () => onTabSelect(tabId as SessionTabId));
    bar.appendChild(btn);
  }

  const actions = document.createElement('div');
  actions.className = 'ide-bar-actions';

  const webBtn = document.createElement('button');
  webBtn.className = 'ide-bar-btn ide-bar-web';
  webBtn.dataset.action = 'web';
  webBtn.title = t('sessionTabs.web');
  webBtn.innerHTML = '<span class="ide-bar-btn-icon">\u{1F310}</span>';
  webBtn.addEventListener('click', () => webClickHandler?.());
  actions.appendChild(webBtn);

  const cmdBtn = document.createElement('button');
  cmdBtn.className = 'ide-bar-btn ide-bar-commands';
  cmdBtn.dataset.action = 'commands';
  cmdBtn.title = t('sessionTabs.commands');
  cmdBtn.innerHTML = '<span class="ide-bar-btn-icon">\u26A1</span>';
  cmdBtn.addEventListener('click', () => commandsClickHandler?.());
  actions.appendChild(cmdBtn);

  const gitBtn = document.createElement('button');
  gitBtn.className = 'ide-bar-btn git-indicator';
  gitBtn.dataset.action = 'git';
  gitBtn.title = t('sessionTabs.git');
  gitBtn.innerHTML =
    '<span class="git-indicator-branch">\u2387</span>' +
    '<span class="git-indicator-stats"></span>';
  gitBtn.addEventListener('click', () => gitClickHandler?.());
  actions.appendChild(gitBtn);

  bar.appendChild(actions);

  return bar;
}

export function setActiveTab(bar: HTMLDivElement, tabId: SessionTabId): void {
  bar.querySelectorAll('.session-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
}

export function setActionActive(
  bar: HTMLDivElement,
  actionId: IdeBarActionId,
  active: boolean,
): void {
  const btn = bar.querySelector(`[data-action="${actionId}"]`);
  btn?.classList.toggle('sidebar-active', active);
}

export function updateCwd(bar: HTMLDivElement, cwd: string): void {
  const cwdSpan = bar.querySelector('.session-cwd');
  if (cwdSpan) {
    cwdSpan.textContent = cwd;
  }
}

export function updateGitIndicator(bar: HTMLDivElement, status: GitStatusResponse | null): void {
  const branchSpan = bar.querySelector('.git-indicator-branch');
  const statsSpan = bar.querySelector('.git-indicator-stats');
  if (!statsSpan) return;

  if (!status) {
    if (branchSpan) branchSpan.textContent = '\u2387';
    statsSpan.innerHTML =
      '<span class="git-indicator-added">+0</span> ' +
      '<span class="git-indicator-deleted">-0</span>';
    return;
  }

  if (branchSpan) {
    branchSpan.textContent = '\u2387';
  }

  const additions = status.totalAdditions ?? 0;
  const deletions = status.totalDeletions ?? 0;

  statsSpan.innerHTML =
    `<span class="git-indicator-added">+${additions}</span> ` +
    `<span class="git-indicator-deleted">-${deletions}</span>`;
}
