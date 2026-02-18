/**
 * Git Panel
 *
 * Accordion-style git status viewer with hierarchical file trees
 * and floating diff viewer.
 */

import type { GitStatusResponse, GitFileEntry, GitLogEntry } from './types';
import { fetchGitStatus } from './gitApi';
import { escapeHtml } from '../../utils';
import { t } from '../i18n';
import { openDiffOverlay } from './gitDiff';

type SectionId = 'staged' | 'changes' | 'untracked';

interface GitPanelState {
  sessionId: string;
  container: HTMLElement;
  status: GitStatusResponse | null;
  expandedSection: SectionId | null;
  showCommits: boolean;
}

const panelStates = new Map<string, GitPanelState>();

export function createGitPanel(container: HTMLElement, sessionId: string): void {
  const state: GitPanelState = {
    sessionId,
    container,
    status: null,
    expandedSection: null,
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

export async function renderGitPanelInto(container: HTMLElement, sessionId: string): Promise<void> {
  let state = panelStates.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      container,
      status: null,
      expandedSection: null,
      showCommits: false,
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

function statusToLetter(status: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A';
    case 'deleted':
      return 'D';
    default:
      return 'C';
  }
}

function statusToColor(status: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'green';
    case 'deleted':
      return 'red';
    default:
      return 'yellow';
  }
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: GitFileEntry | null;
}

function buildFileTree(files: GitFileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), file: null };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          file: null,
        });
      }
      node = node.children.get(part)!;
    }
    const fileName = parts[parts.length - 1]!;
    node.children.set(fileName, {
      name: fileName,
      path: file.path,
      children: new Map(),
      file,
    });
  }
  return root;
}

function renderTreeNode(node: TreeNode, depth: number): string {
  let html = '';
  const sorted = [...node.children.values()].sort((a, b) => {
    const aIsDir = a.children.size > 0 && !a.file;
    const bIsDir = b.children.size > 0 && !b.file;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const child of sorted) {
    const indent = depth * 16;
    if (child.file) {
      const letter = statusToLetter(child.file.status);
      const color = statusToColor(child.file.status);
      html += `<div class="git-tree-file" data-path="${escapeHtml(child.file.path)}" style="padding-left:${12 + indent}px">
        <span class="git-tree-name">${escapeHtml(child.name)}</span>
        <span class="git-file-indicator git-indicator-${color}">${letter}</span>
      </div>`;
    } else {
      html += `<div class="git-tree-dir" style="padding-left:${12 + indent}px">
        <span class="git-tree-dir-name">${escapeHtml(child.name)}/</span>
      </div>`;
      html += renderTreeNode(child, depth + 1);
    }
  }
  return html;
}

function tallyLoc(files: GitFileEntry[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.additions ?? 0;
    del += f.deletions ?? 0;
  }
  return { add, del };
}

function renderPanel(state: GitPanelState): void {
  const { status, container } = state;

  if (!status) {
    container.innerHTML = `
      <div class="git-panel">
        <div class="git-panel-empty">
          <p>${t('git.notARepo')}</p>
          <p class="git-panel-hint">${t('git.notARepoHint')}</p>
        </div>
      </div>`;
    return;
  }

  const hasStaged = status.staged.length > 0;
  const hasChanges = status.modified.length > 0;
  const hasUntracked = status.untracked.length > 0;

  let html = '<div class="git-panel">';

  if (hasStaged) {
    html += renderSection(state, 'staged', t('git.stagedChanges'), status.staged);
  }
  if (hasChanges) {
    html += renderSection(state, 'changes', t('git.changes'), status.modified);
  }
  if (hasUntracked) {
    html += renderSection(state, 'untracked', t('git.untracked'), status.untracked);
  }

  if (!hasStaged && !hasChanges && !hasUntracked) {
    html += `<div class="git-panel-clean">
      <span>\u2714</span> ${t('git.workingTreeClean')}
    </div>`;
  }

  html += renderCommitsSection(state, status.recentCommits);

  if (status.stashCount > 0) {
    html += `<div class="git-stash-footer">
      <span class="git-stash-label">${t('git.stash')} (${status.stashCount})</span>
    </div>`;
  }

  html += '</div>';
  container.innerHTML = html;
  bindPanelEvents(state);
}

function renderSection(
  state: GitPanelState,
  sectionId: SectionId,
  title: string,
  files: GitFileEntry[],
): string {
  const isExpanded = state.expandedSection === sectionId;
  const count = files.length;
  const loc = tallyLoc(files);

  let locHtml = '';
  if (sectionId !== 'untracked') {
    locHtml =
      ` <span class="git-section-loc">` +
      `<span class="git-loc-add">+${loc.add}</span> ` +
      `<span class="git-loc-del">-${loc.del}</span>` +
      `</span>`;
  }

  let html = `<div class="git-section${isExpanded ? ' git-section-expanded' : ''}">
    <button class="git-section-header" data-section="${sectionId}">
      <span class="git-section-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
      <span class="git-section-title">${escapeHtml(title)}</span>
      <span class="git-section-count">${count}</span>
      ${locHtml}
    </button>`;

  if (isExpanded) {
    const tree = buildFileTree(files);
    html += `<div class="git-section-body">`;
    html += renderTreeNode(tree, 0);
    html += `</div>`;
  }

  html += '</div>';
  return html;
}

function renderCommitsSection(state: GitPanelState, commits: GitLogEntry[]): string {
  if (commits.length === 0) return '';

  let html = `<div class="git-commits-section">
    <button class="git-section-toggle" data-section="commits">
      ${t('git.recentCommits')} (${commits.length})
      <span class="git-section-chevron">${state.showCommits ? '\u25BE' : '\u25B8'}</span>
    </button>`;

  if (state.showCommits) {
    html += '<div class="git-commits-list">';
    for (const commit of commits) {
      html += `<div class="git-commit-entry">
        <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
        <span class="git-commit-msg">${escapeHtml(commit.message)}</span>
      </div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function bindPanelEvents(state: GitPanelState): void {
  const { container, sessionId, status } = state;

  container.querySelectorAll<HTMLElement>('.git-section-header').forEach((el) => {
    el.addEventListener('click', () => {
      const section = el.dataset.section as SectionId;
      state.expandedSection = state.expandedSection === section ? null : section;
      renderPanel(state);
    });
  });

  container.querySelector('.git-section-toggle')?.addEventListener('click', () => {
    state.showCommits = !state.showCommits;
    renderPanel(state);
  });

  container.querySelectorAll<HTMLElement>('.git-tree-file').forEach((el) => {
    el.addEventListener('click', () => {
      const path = el.dataset.path;
      if (!path || !status) return;

      const isStaged = status.staged.some((f) => f.path === path);
      const isUntracked = status.untracked.some((f) => f.path === path);

      if (isUntracked) return;

      openDiffOverlay(sessionId, path, isStaged);
    });
  });
}
