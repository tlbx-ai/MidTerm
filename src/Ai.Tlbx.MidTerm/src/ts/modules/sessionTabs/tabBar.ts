/**
 * Session Tab Bar
 *
 * Creates and manages the session bar UI for each session.
 * Tabs: Primary session surface | Files
 * Right-aligned actions: WEB | Share | Git dock toggle
 */

import type { GitStatusResponse } from '../git/types';
import { t } from '../i18n';

export type SessionTabId = 'terminal' | 'agent' | 'files';

export type IdeBarActionId = 'git' | 'commands' | 'web' | 'share';

const WEB_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="8"></circle>' +
  '<path d="M4 12h16"></path>' +
  '<path d="M12 4a11.5 11.5 0 0 1 0 16"></path>' +
  '<path d="M12 4a11.5 11.5 0 0 0 0 16"></path>' +
  '</svg>';

const SHARE_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="18" cy="5.5" r="2"></circle>' +
  '<circle cx="6" cy="12" r="2"></circle>' +
  '<circle cx="18" cy="18.5" r="2"></circle>' +
  '<path d="m7.75 11 8-4.25"></path>' +
  '<path d="m7.75 13 8 4.25"></path>' +
  '</svg>';

const GIT_BUTTON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="7" cy="6" r="1.75"></circle>' +
  '<circle cx="7" cy="18" r="1.75"></circle>' +
  '<circle cx="17" cy="12" r="1.75"></circle>' +
  '<path d="M8.75 6h3a4 4 0 0 1 4 4v2"></path>' +
  '<path d="M8.75 18h3a4 4 0 0 0 4-4v-2"></path>' +
  '</svg>';

function getTabLabels(): Record<SessionTabId, string> {
  return {
    terminal: t('session.terminal'),
    agent: t('sessionTabs.agent'),
    files: t('sessionTabs.files'),
  };
}

function getVisibleTabs(): SessionTabId[] {
  return ['terminal', 'agent', 'files'];
}

function createActionIcon(svgMarkup: string): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.className = 'ide-bar-btn-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = svgMarkup;
  return icon;
}

function createActionLabel(text: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'ide-bar-btn-label';
  label.textContent = text;
  return label;
}

function createTextNode(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function createBetaBadge(): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'feature-beta-badge';
  badge.textContent = t('common.beta');
  return badge;
}

function buildGitStatsMarkup(additions: number, deletions: number): string {
  return (
    `<span class="git-indicator-added">+${additions}</span>` +
    `<span class="git-indicator-deleted">-${deletions}</span>`
  );
}

interface GitIndicatorViewModel {
  branchText: string;
  statusText: string;
  additions: number;
  deletions: number;
  title: string;
  isEmpty: boolean;
}

function createGitIndicatorButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ide-bar-btn git-indicator';
  btn.dataset.action = 'git';
  btn.appendChild(createActionIcon(GIT_BUTTON_ICON));

  const meta = document.createElement('span');
  meta.className = 'git-indicator-meta';

  const primaryLine = document.createElement('span');
  primaryLine.className = 'git-indicator-line git-indicator-line-primary';
  primaryLine.appendChild(createTextNode('git-indicator-branch', t('git.noRepoShort')));
  primaryLine.appendChild(createTextNode('git-indicator-separator', ''));
  primaryLine.appendChild(createTextNode('git-indicator-status', ''));

  const secondaryLine = document.createElement('span');
  secondaryLine.className = 'git-indicator-line git-indicator-line-secondary git-indicator-stats';
  secondaryLine.innerHTML = buildGitStatsMarkup(0, 0);

  meta.appendChild(primaryLine);
  meta.appendChild(secondaryLine);
  btn.appendChild(meta);
  btn.title = t('sessionTabs.git');
  btn.setAttribute('aria-label', t('sessionTabs.git'));
  btn.addEventListener('click', onClick);
  return btn;
}

function hasGitStatus(status: GitStatusResponse | null): status is GitStatusResponse {
  if (!status) {
    return false;
  }

  return Boolean(status.repoRoot || status.branch);
}

function buildGitIndicatorViewModel(status: GitStatusResponse | null): GitIndicatorViewModel {
  if (!hasGitStatus(status)) {
    return {
      branchText: t('git.noRepoShort'),
      statusText: '',
      additions: 0,
      deletions: 0,
      title: `${t('sessionTabs.git')}: ${t('git.noRepoShort')}`,
      isEmpty: true,
    };
  }

  const changedCount =
    status.staged.length +
    status.modified.length +
    status.untracked.length +
    status.conflicted.length;
  let statusText = t('git.cleanShort');

  if (status.conflicted.length > 0) {
    statusText = `!${status.conflicted.length}`;
  } else if (changedCount > 0) {
    statusText = `~${changedCount}`;
  } else if (status.ahead > 0 || status.behind > 0) {
    const syncParts: string[] = [];
    if (status.ahead > 0) {
      syncParts.push(`↑${status.ahead}`);
    }
    if (status.behind > 0) {
      syncParts.push(`↓${status.behind}`);
    }
    statusText = syncParts.join(' ');
  }

  const branchText = status.branch || 'HEAD';
  const additions = status.totalAdditions;
  const deletions = status.totalDeletions;
  const title =
    `${t('sessionTabs.git')}: ${branchText}` +
    (statusText ? ` / ${statusText}` : '') +
    `, +${additions} -${deletions}`;

  return {
    branchText,
    statusText,
    additions,
    deletions,
    title,
    isEmpty: false,
  };
}

function createActionButton(
  actionId: IdeBarActionId,
  className: string,
  title: string,
  label: string,
  iconMarkup: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = className;
  btn.dataset.action = actionId;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(createActionIcon(iconMarkup));
  btn.appendChild(createActionLabel(label));
  btn.addEventListener('click', onClick);
  return btn;
}

let gitClickHandler: (() => void) | null = null;
let webClickHandler: (() => void) | null = null;
let shareClickHandler: ((sessionId: string) => void) | null = null;
export function setCommandsClickHandler(_handler: () => void): void {
  // Commands is temporarily hidden from the IDE bar, so registration is ignored.
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
  initialTab: SessionTabId = 'terminal',
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

  const labels = getTabLabels();
  for (const tabId of getVisibleTabs()) {
    const label = labels[tabId];
    const btn = document.createElement('button');
    btn.className = 'session-tab';
    if (tabId === initialTab) btn.classList.add('active');
    btn.dataset.tab = tabId;
    const labelNode = document.createElement('span');
    labelNode.className = 'session-tab-label';
    labelNode.textContent = label;
    btn.appendChild(labelNode);
    if (tabId === 'agent') {
      btn.appendChild(createBetaBadge());
    }
    btn.addEventListener('click', () => {
      onTabSelect(tabId);
    });
    bar.appendChild(btn);
  }

  const actions = document.createElement('div');
  actions.className = 'ide-bar-actions';

  const webBtn = createActionButton(
    'web',
    'ide-bar-btn ide-bar-web',
    t('sessionTabs.web'),
    t('sessionTabs.webShort'),
    WEB_BUTTON_ICON,
    () => webClickHandler?.(),
  );
  actions.appendChild(webBtn);

  const shareBtn = createActionButton(
    'share',
    'ide-bar-btn ide-bar-share',
    t('sessionTabs.share'),
    t('sessionTabs.share'),
    SHARE_BUTTON_ICON,
    () => shareClickHandler?.(sessionId),
  );
  actions.appendChild(shareBtn);

  const gitBtn = createGitIndicatorButton(() => gitClickHandler?.());
  actions.appendChild(gitBtn);

  bar.appendChild(actions);

  return bar;
}

export function setActiveTab(bar: HTMLDivElement, tabId: SessionTabId): void {
  bar.querySelectorAll('.session-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
}

export function setTabVisible(bar: HTMLDivElement, tabId: SessionTabId, visible: boolean): void {
  const btn = bar.querySelector<HTMLButtonElement>(`.session-tab[data-tab="${tabId}"]`);
  if (!btn) {
    return;
  }

  btn.hidden = !visible;
}

export function setTabLabel(bar: HTMLDivElement, tabId: SessionTabId, label: string): void {
  const btn = bar.querySelector<HTMLButtonElement>(`.session-tab[data-tab="${tabId}"]`);
  if (!btn) {
    return;
  }

  const labelNode = btn.querySelector<HTMLElement>('.session-tab-label');
  if (labelNode) {
    labelNode.textContent = label;
  }

  btn.title = label;
  btn.setAttribute('aria-label', label);
}

export function isTabVisible(bar: HTMLDivElement, tabId: SessionTabId): boolean {
  const btn = bar.querySelector<HTMLButtonElement>(`.session-tab[data-tab="${tabId}"]`);
  return btn?.hidden !== true;
}

export function setActionActive(
  bar: HTMLDivElement,
  actionId: IdeBarActionId,
  active: boolean,
): void {
  const btn = bar.querySelector(`[data-action="${actionId}"]`);
  btn?.classList.toggle('sidebar-active', active);
}

export function setActionVisible(
  bar: HTMLDivElement,
  actionId: IdeBarActionId,
  visible: boolean,
): void {
  const btn = bar.querySelector<HTMLButtonElement>(`[data-action="${actionId}"]`);
  if (!btn) {
    return;
  }

  btn.hidden = !visible;
}

export function updateCwd(bar: HTMLDivElement, cwd: string): void {
  const cwdSpan = bar.querySelector('.session-cwd');
  if (cwdSpan) {
    cwdSpan.textContent = cwd;
    cwdSpan.setAttribute('title', cwd);
  }
}

export function updateGitIndicator(bar: HTMLDivElement, status: GitStatusResponse | null): void {
  const button = bar.querySelector<HTMLButtonElement>('.git-indicator');
  const branchSpan = bar.querySelector('.git-indicator-branch');
  const separatorSpan = bar.querySelector('.git-indicator-separator');
  const statusSpan = bar.querySelector('.git-indicator-status');
  const statsSpan = bar.querySelector('.git-indicator-stats');
  if (!button || !branchSpan || !separatorSpan || !statusSpan || !statsSpan) return;

  const viewModel = buildGitIndicatorViewModel(status);

  branchSpan.textContent = viewModel.branchText;
  statusSpan.textContent = viewModel.statusText;
  separatorSpan.textContent = viewModel.statusText ? '/' : '';
  statsSpan.innerHTML = buildGitStatsMarkup(viewModel.additions, viewModel.deletions);
  button.title = viewModel.title;
  button.setAttribute('aria-label', viewModel.title);
  button.classList.toggle('git-indicator-empty', viewModel.isEmpty);
}
