/**
 * Git Panel
 *
 * Read-only git status viewer with click-to-diff.
 */

import type { GitStatusResponse, GitFileEntry, GitLogEntry } from './types';
import { fetchDiff, fetchGitStatus } from './gitApi';
import { renderDiff } from './gitDiff';
import { escapeHtml } from '../../utils';

interface GitPanelState {
  sessionId: string;
  container: HTMLElement;
  status: GitStatusResponse | null;
  showCommits: boolean;
  activeDiffPath: string | null;
  activeDiffHtml: string | null;
}

const panelStates = new Map<string, GitPanelState>();

export function createGitPanel(container: HTMLElement, sessionId: string): void {
  const state: GitPanelState = {
    sessionId,
    container,
    status: null,
    showCommits: false,
    activeDiffPath: null,
    activeDiffHtml: null,
  };
  panelStates.set(sessionId, state);
  renderPanel(state);
}

export function updateGitStatus(sessionId: string, status: GitStatusResponse): void {
  const state = panelStates.get(sessionId);
  if (!state) return;
  state.status = status;
  renderPanel(state);
}

export async function refreshGitPanel(sessionId: string): Promise<void> {
  const status = await fetchGitStatus(sessionId);
  if (status) {
    updateGitStatus(sessionId, status);
  }
}

export async function renderGitPanelInto(container: HTMLElement, sessionId: string): Promise<void> {
  let state = panelStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      container,
      status: null,
      showCommits: false,
      activeDiffPath: null,
      activeDiffHtml: null,
    };
    panelStates.set(sessionId, state);
  } else {
    state.container = container;
  }

  const status = await fetchGitStatus(sessionId);
  if (status) {
    state.status = status;
  }
  renderPanel(state);
}

export function destroyGitPanel(sessionId: string): void {
  panelStates.delete(sessionId);
}

function renderPanel(state: GitPanelState): void {
  const { status, container } = state;

  if (!status) {
    container.innerHTML = `
      <div class="git-panel">
        <div class="git-panel-empty">
          <p>Not a git repository</p>
          <p class="git-panel-hint">Navigate to a git repository to see status</p>
        </div>
      </div>`;
    return;
  }

  let html = '<div class="git-panel">';

  html += `<div class="git-header">
    <div class="git-branch">
      <span class="git-branch-icon">\u2387</span>
      <span class="git-branch-name">${escapeHtml(status.branch)}</span>
      ${status.ahead > 0 ? `<span class="git-badge git-badge-ahead">\u2191${status.ahead}</span>` : ''}
      ${status.behind > 0 ? `<span class="git-badge git-badge-behind">\u2193${status.behind}</span>` : ''}
    </div>
    ${status.stashCount > 0 ? `<span class="git-badge git-badge-stash">Stash (${status.stashCount})</span>` : ''}
  </div>`;

  if (status.conflicted.length > 0) {
    html += renderFileSection(state, 'Conflicts', 'conflicted', status.conflicted, 'red');
  }

  html += renderFileSection(state, 'Staged Changes', 'staged', status.staged, 'green');
  html += renderFileSection(state, 'Changes', 'modified', status.modified, 'yellow');
  html += renderFileSection(state, 'Untracked', 'untracked', status.untracked, 'grey');

  html += `<div class="git-commits-section">
    <button class="git-section-toggle" data-section="commits">
      Recent Commits (${status.recentCommits.length})
      <span class="git-section-chevron">${state.showCommits ? '\u25BE' : '\u25B8'}</span>
    </button>
    ${state.showCommits ? renderCommitList(status.recentCommits) : ''}
  </div>`;

  html += '</div>';
  container.innerHTML = html;
  bindPanelEvents(state);
}

function renderFileSection(
  state: GitPanelState,
  title: string,
  type: string,
  files: GitFileEntry[],
  color: string,
): string {
  const count = files.length;
  let html = `<div class="git-section">
    <div class="git-section-header git-section-${color}">
      <span>${escapeHtml(title)}</span>
      <span class="git-section-count">${count}</span>
    </div>`;

  for (const file of files) {
    const fileName = file.path.split('/').pop() ?? file.path;
    const dirPath = file.path.includes('/')
      ? file.path.substring(0, file.path.lastIndexOf('/') + 1)
      : '';
    const isActive = state.activeDiffPath === `${type}:${file.path}`;

    html += `<div class="git-file-entry git-file-clickable${isActive ? ' git-file-active' : ''}" data-path="${escapeHtml(file.path)}" data-type="${type}">
      <span class="git-file-status git-status-${color}">${escapeHtml(file.status)}</span>
      <span class="git-file-path">
        ${dirPath ? `<span class="git-file-dir">${escapeHtml(dirPath)}</span>` : ''}${escapeHtml(fileName)}
      </span>
    </div>`;

    if (isActive && state.activeDiffHtml) {
      html += `<div class="git-diff-inline">${state.activeDiffHtml}</div>`;
    }
  }

  html += '</div>';
  return html;
}

function renderCommitList(commits: GitLogEntry[]): string {
  if (commits.length === 0) return '<div class="git-commits-empty">No commits</div>';

  let html = '<div class="git-commits-list">';
  for (const commit of commits) {
    html += `<div class="git-commit-entry">
      <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
      <span class="git-commit-msg">${escapeHtml(commit.message)}</span>
      <span class="git-commit-author">${escapeHtml(commit.author)}</span>
    </div>`;
  }
  html += '</div>';
  return html;
}

function bindPanelEvents(state: GitPanelState): void {
  const { container, sessionId } = state;

  container.querySelectorAll('.git-file-clickable').forEach((el) => {
    el.addEventListener('click', async () => {
      const entry = el as HTMLElement;
      const path = entry.dataset.path;
      const type = entry.dataset.type;
      if (!path) return;

      const key = `${type}:${path}`;
      if (state.activeDiffPath === key) {
        state.activeDiffPath = null;
        state.activeDiffHtml = null;
        renderPanel(state);
        return;
      }

      const staged = type === 'staged';
      if (type === 'untracked') {
        state.activeDiffPath = key;
        state.activeDiffHtml = renderDiff('');
        renderPanel(state);
        return;
      }

      const diff = await fetchDiff(sessionId, path, staged);
      state.activeDiffPath = key;
      state.activeDiffHtml = renderDiff(diff ?? '');
      renderPanel(state);
    });
  });

  container.querySelector('.git-section-toggle')?.addEventListener('click', () => {
    state.showCommits = !state.showCommits;
    renderPanel(state);
  });
}
