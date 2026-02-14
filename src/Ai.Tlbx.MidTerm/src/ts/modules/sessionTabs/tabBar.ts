/**
 * Session Tab Bar
 *
 * Creates and manages the tab bar UI for each session.
 * Tabs: Terminal | Files | Git | Commands
 */

export type SessionTabId = 'terminal' | 'files' | 'git' | 'commands';

const TAB_LABELS: Record<SessionTabId, string> = {
  terminal: 'Terminal',
  files: 'Files',
  git: 'Git',
  commands: 'Commands',
};

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

  return bar;
}

export function setActiveTab(bar: HTMLDivElement, tabId: SessionTabId): void {
  bar.querySelectorAll('.session-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
}

export function updateCwd(bar: HTMLDivElement, cwd: string): void {
  const cwdSpan = bar.querySelector('.session-cwd');
  if (cwdSpan) {
    cwdSpan.textContent = cwd;
  }
}
