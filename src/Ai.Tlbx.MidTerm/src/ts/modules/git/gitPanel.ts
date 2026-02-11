/**
 * Git Panel
 *
 * Main git UI rendered inside the Git tab panel.
 */

import type { GitStatusResponse, GitFileEntry, GitLogEntry } from './types';
import {
  stageFiles,
  unstageFiles,
  commitChanges,
  pushChanges,
  pullChanges,
  stashChanges,
  discardChanges,
  fetchDiff,
  fetchGitStatus,
} from './gitApi';
import { renderDiff } from './gitDiff';
import { escapeHtml } from '../../utils';

interface GitPanelState {
  sessionId: string;
  container: HTMLElement;
  status: GitStatusResponse | null;
  showCommits: boolean;
}

const panelStates = new Map<string, GitPanelState>();

export function createGitPanel(container: HTMLElement, sessionId: string): void {
  const state: GitPanelState = {
    sessionId,
    container,
    status: null,
    showCommits: false,
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

  const stagedCount = status.staged.length;

  let html = '<div class="git-panel">';

  // Header
  html += `<div class="git-header">
    <div class="git-branch">
      <span class="git-branch-icon">\u2387</span>
      <span class="git-branch-name">${escapeHtml(status.branch)}</span>
      ${status.ahead > 0 ? `<span class="git-badge git-badge-ahead">\u2191${status.ahead}</span>` : ''}
      ${status.behind > 0 ? `<span class="git-badge git-badge-behind">\u2193${status.behind}</span>` : ''}
    </div>
    <div class="git-header-actions">
      <button class="git-action-btn" data-action="pull" title="Pull">\u2193 Pull</button>
      <button class="git-action-btn" data-action="push" title="Push">\u2191 Push</button>
      ${
        status.stashCount > 0
          ? `<button class="git-action-btn" data-action="stash-pop" title="Pop stash">Stash (${status.stashCount})</button>`
          : `<button class="git-action-btn" data-action="stash-push" title="Stash changes">Stash</button>`
      }
    </div>
  </div>`;

  // Conflicted
  if (status.conflicted.length > 0) {
    html += renderFileSection('Conflicts', 'conflicted', status.conflicted, 'red');
  }

  // Staged
  html += renderFileSection('Staged Changes', 'staged', status.staged, 'green');

  // Modified
  html += renderFileSection('Changes', 'modified', status.modified, 'yellow');

  // Untracked
  html += renderFileSection('Untracked', 'untracked', status.untracked, 'grey');

  // Commit area
  html += `<div class="git-commit-area">
    <textarea class="git-commit-input" placeholder="Commit message..." rows="3"></textarea>
    <div class="git-commit-actions">
      <button class="git-commit-btn" ${stagedCount === 0 ? 'disabled' : ''}>Commit (${stagedCount})</button>
    </div>
  </div>`;

  // Recent commits
  html += `<div class="git-commits-section">
    <button class="git-section-toggle" data-section="commits">
      Recent Commits (${status.recentCommits.length})
      <span class="git-section-chevron">${state.showCommits ? '\u25BE' : '\u25B8'}</span>
    </button>
    ${state.showCommits ? renderCommitList(status.recentCommits) : ''}
  </div>`;

  html += '</div>';

  // Preserve commit message across re-renders
  const existingInput = container.querySelector('.git-commit-input') as HTMLTextAreaElement | null;
  const savedMessage = existingInput?.value ?? '';

  container.innerHTML = html;

  if (savedMessage) {
    const newInput = container.querySelector('.git-commit-input') as HTMLTextAreaElement | null;
    if (newInput) newInput.value = savedMessage;
  }

  bindPanelEvents(state);
}

function renderFileSection(
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
      ${
        type === 'modified' || type === 'untracked'
          ? `<button class="git-section-action" data-action="stage-all" data-type="${type}">+</button>`
          : ''
      }
      ${
        type === 'staged'
          ? `<button class="git-section-action" data-action="unstage-all">-</button>`
          : ''
      }
    </div>`;

  for (const file of files) {
    const fileName = file.path.split('/').pop() ?? file.path;
    const dirPath = file.path.includes('/')
      ? file.path.substring(0, file.path.lastIndexOf('/') + 1)
      : '';

    html += `<div class="git-file-entry" data-path="${escapeHtml(file.path)}" data-type="${type}">
      <span class="git-file-status git-status-${color}">${escapeHtml(file.status)}</span>
      <span class="git-file-path">
        ${dirPath ? `<span class="git-file-dir">${escapeHtml(dirPath)}</span>` : ''}${escapeHtml(fileName)}
      </span>
      <span class="git-file-actions">
        ${type === 'staged' ? `<button class="git-file-btn" data-action="unstage" title="Unstage">-</button>` : ''}
        ${type === 'modified' ? `<button class="git-file-btn" data-action="stage" title="Stage">+</button>` : ''}
        ${type === 'modified' ? `<button class="git-file-btn git-file-btn-danger" data-action="discard" title="Discard">\u2715</button>` : ''}
        ${type === 'untracked' ? `<button class="git-file-btn" data-action="stage" title="Stage">+</button>` : ''}
        ${type !== 'untracked' ? `<button class="git-file-btn" data-action="diff" title="Diff">\u2194</button>` : ''}
      </span>
    </div>`;
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

  // Header action buttons
  container.querySelectorAll('.git-action-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'push') await pushChanges(sessionId);
      else if (action === 'pull') await pullChanges(sessionId);
      else if (action === 'stash-push') await stashChanges(sessionId, 'push');
      else if (action === 'stash-pop') await stashChanges(sessionId, 'pop');
    });
  });

  // Section-level stage/unstage all
  container.querySelectorAll('.git-section-action').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = (btn as HTMLElement).dataset.action;
      const type = (btn as HTMLElement).dataset.type;
      if (!state.status) return;

      if (action === 'stage-all') {
        const files = type === 'modified' ? state.status.modified : state.status.untracked;
        await stageFiles(
          sessionId,
          files.map((f) => f.path),
        );
      } else if (action === 'unstage-all') {
        await unstageFiles(
          sessionId,
          state.status.staged.map((f) => f.path),
        );
      }
    });
  });

  // Per-file actions
  container.querySelectorAll('.git-file-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      const entry = (btn as HTMLElement).closest('.git-file-entry') as HTMLElement;
      const path = entry?.dataset.path;
      const type = entry?.dataset.type;
      if (!path) return;

      if (action === 'stage') await stageFiles(sessionId, [path]);
      else if (action === 'unstage') await unstageFiles(sessionId, [path]);
      else if (action === 'discard') {
        if (confirm(`Discard changes to ${path}?`)) {
          await discardChanges(sessionId, [path]);
        }
      } else if (action === 'diff') {
        const staged = type === 'staged';
        const diff = await fetchDiff(sessionId, path, staged);
        if (diff !== null) {
          showDiffInline(entry, diff);
        }
      }
    });
  });

  // Commit
  const commitBtn = container.querySelector('.git-commit-btn');
  const commitInput = container.querySelector('.git-commit-input') as HTMLTextAreaElement;
  commitBtn?.addEventListener('click', async () => {
    const message = commitInput?.value?.trim();
    if (!message) return;
    const success = await commitChanges(sessionId, message);
    if (success && commitInput) {
      commitInput.value = '';
    }
  });

  // Toggle commits section
  container.querySelector('.git-section-toggle')?.addEventListener('click', () => {
    state.showCommits = !state.showCommits;
    renderPanel(state);
  });
}

function showDiffInline(entryEl: HTMLElement, diffText: string): void {
  const existing = entryEl.nextElementSibling;
  if (existing?.classList.contains('git-diff-inline')) {
    existing.remove();
    return;
  }

  const diffEl = document.createElement('div');
  diffEl.className = 'git-diff-inline';
  diffEl.innerHTML = renderDiff(diffText);
  entryEl.after(diffEl);
}
