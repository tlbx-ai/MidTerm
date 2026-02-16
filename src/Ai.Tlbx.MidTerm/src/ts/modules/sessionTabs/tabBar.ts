/**
 * Session Tab Bar
 *
 * Creates and manages the tab bar UI for each session.
 * Tabs: Terminal | Files
 * Right-aligned actions: Commands (⚡) | Git status indicator
 */

import type { GitStatusResponse } from '../git/types';

export type SessionTabId = 'terminal' | 'files';

export type IdeBarActionId = 'git' | 'commands';

const TAB_LABELS: Record<SessionTabId, string> = {
  terminal: 'Terminal',
  files: 'Files',
};

let commandsClickHandler: (() => void) | null = null;
let gitClickHandler: (() => void) | null = null;

export function setCommandsClickHandler(handler: () => void): void {
  commandsClickHandler = handler;
}

export function setGitClickHandler(handler: () => void): void {
  gitClickHandler = handler;
}

export function createTabBar(
  sessionId: string,
  onTabSelect: (tab: SessionTabId) => void,
): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'session-tab-bar';
  bar.dataset.sessionId = sessionId;

  for (const [tabId, label] of Object.entries(TAB_LABELS)) {
    const btn = document.createElement('button');
    btn.className = 'session-tab';
    if (tabId === 'terminal') btn.classList.add('active');
    btn.dataset.tab = tabId;
    btn.textContent = label;
    btn.addEventListener('click', () => onTabSelect(tabId as SessionTabId));
    bar.appendChild(btn);
  }

  const cwdSpan = document.createElement('span');
  cwdSpan.className = 'session-cwd';
  bar.appendChild(cwdSpan);

  const actions = document.createElement('div');
  actions.className = 'ide-bar-actions';

  const cmdBtn = document.createElement('button');
  cmdBtn.className = 'ide-bar-btn ide-bar-commands';
  cmdBtn.dataset.action = 'commands';
  cmdBtn.title = 'Commands';
  cmdBtn.innerHTML = '<span class="ide-bar-btn-icon">\u26A1</span>';
  cmdBtn.addEventListener('click', () => commandsClickHandler?.());
  actions.appendChild(cmdBtn);

  const gitBtn = document.createElement('button');
  gitBtn.className = 'ide-bar-btn git-indicator';
  gitBtn.dataset.action = 'git';
  gitBtn.title = 'Git';
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
    statsSpan.innerHTML = '';
    return;
  }

  if (branchSpan) {
    branchSpan.textContent = status.branch || '\u2387';
  }

  const added = status.staged.length + status.untracked.length;
  const changed = status.modified.length;

  const parts: string[] = [];
  if (added > 0) {
    parts.push(`<span class="git-indicator-added">+${added}</span>`);
  }
  if (changed > 0) {
    parts.push(`<span class="git-indicator-changed">\u00B1${changed}</span>`);
  }

  statsSpan.innerHTML = parts.join(' ');
}
