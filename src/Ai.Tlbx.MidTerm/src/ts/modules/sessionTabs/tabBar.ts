/**
 * Session Tab Bar
 *
 * Creates and manages the tab bar UI for each session.
 * Tabs: Terminal | Files
 * Right-aligned actions: Web Preview | Commands | Git status indicator
 */

import type { GitStatusResponse } from '../git/types';
import { t } from '../i18n';

export type SessionTabId = 'terminal' | 'files';

export type IdeBarActionId = 'git' | 'commands' | 'web' | 'share';

const WEB_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3.5" y="5" width="17" height="14" rx="2.5"></rect>' +
  '<path d="M3.5 8.5h17"></path>' +
  '<path d="m10 11-2.5 2.5L10 16"></path>' +
  '<path d="m14 11 2.5 2.5L14 16"></path>' +
  '<path d="m13 10-2 7"></path>' +
  '</svg>';

const COMMANDS_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>' +
  '<path d="m7.5 10 3 2.5-3 2.5"></path>' +
  '<path d="M12.5 15h4.5"></path>' +
  '<path d="M12.5 10h5"></path>' +
  '</svg>';

const SHARE_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 8a3 3 0 1 0-2.83-4H12a3 3 0 0 0 0 6 3 3 0 0 0 3-2Z"></path>' +
  '<path d="m8.5 13.5 6-3"></path>' +
  '<path d="m8.5 10.5 6 3"></path>' +
  '<path d="M6 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"></path>' +
  '<path d="M18 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"></path>' +
  '</svg>';

function getTabLabels(): Record<SessionTabId, string> {
  return {
    terminal: t('session.terminal'),
    files: t('sessionTabs.files'),
  };
}

function createActionIcon(svgMarkup: string): string {
  return `<span class="ide-bar-btn-icon" aria-hidden="true">${svgMarkup}</span>`;
}

let commandsClickHandler: (() => void) | null = null;
let gitClickHandler: (() => void) | null = null;
let webClickHandler: (() => void) | null = null;
let shareClickHandler: ((sessionId: string) => void) | null = null;

export function setCommandsClickHandler(handler: () => void): void {
  commandsClickHandler = handler;
}

export function setGitClickHandler(handler: () => void): void {
  gitClickHandler = handler;
}

export function setWebClickHandler(handler: () => void): void {
  webClickHandler = handler;
}

export function setShareClickHandler(handler: (sessionId: string) => void): void {
  shareClickHandler = handler;
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
  cwdSpan.addEventListener('click', () => {
    const cwd = cwdSpan.textContent.trim();
    if (!cwd || typeof navigator.clipboard === 'undefined') {
      return;
    }

    void navigator.clipboard.writeText(cwd).catch(() => {});
  });
  bar.appendChild(cwdSpan);

  for (const [tabId, label] of Object.entries(getTabLabels())) {
    const btn = document.createElement('button');
    btn.className = 'session-tab';
    if (tabId === 'terminal') btn.classList.add('active');
    btn.dataset.tab = tabId;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      onTabSelect(tabId as SessionTabId);
    });
    bar.appendChild(btn);
  }

  const actions = document.createElement('div');
  actions.className = 'ide-bar-actions';

  const webBtn = document.createElement('button');
  webBtn.className = 'ide-bar-btn ide-bar-web';
  webBtn.dataset.action = 'web';
  webBtn.title = t('sessionTabs.web');
  webBtn.setAttribute('aria-label', t('sessionTabs.web'));
  webBtn.innerHTML = createActionIcon(WEB_BUTTON_ICON);
  webBtn.addEventListener('click', () => webClickHandler?.());
  actions.appendChild(webBtn);

  const cmdBtn = document.createElement('button');
  cmdBtn.className = 'ide-bar-btn ide-bar-commands';
  cmdBtn.dataset.action = 'commands';
  cmdBtn.title = t('sessionTabs.commands');
  cmdBtn.setAttribute('aria-label', t('sessionTabs.commands'));
  cmdBtn.innerHTML = createActionIcon(COMMANDS_BUTTON_ICON);
  cmdBtn.addEventListener('click', () => commandsClickHandler?.());
  actions.appendChild(cmdBtn);

  const gitBtn = document.createElement('button');
  gitBtn.className = 'ide-bar-btn git-indicator';
  gitBtn.dataset.action = 'git';
  gitBtn.title = t('sessionTabs.git');
  gitBtn.setAttribute('aria-label', t('sessionTabs.git'));
  gitBtn.innerHTML =
    '<span class="git-indicator-branch">\u2387</span>' +
    '<span class="git-indicator-stats"></span>';
  gitBtn.addEventListener('click', () => gitClickHandler?.());
  actions.appendChild(gitBtn);

  const shareBtn = document.createElement('button');
  shareBtn.className = 'ide-bar-btn ide-bar-share';
  shareBtn.dataset.action = 'share';
  shareBtn.title = t('sessionTabs.share');
  shareBtn.setAttribute('aria-label', t('sessionTabs.share'));
  shareBtn.innerHTML = createActionIcon(SHARE_BUTTON_ICON);
  shareBtn.addEventListener('click', () => shareClickHandler?.(sessionId));
  actions.appendChild(shareBtn);

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
    cwdSpan.setAttribute('title', cwd);
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

  const additions = status.totalAdditions;
  const deletions = status.totalDeletions;

  statsSpan.innerHTML =
    `<span class="git-indicator-added">+${additions}</span> ` +
    `<span class="git-indicator-deleted">-${deletions}</span>`;
}
