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

type SectionId = 'conflicts' | 'staged' | 'changes' | 'untracked';
type PanelSectionId = SectionId | 'commits';

interface GitPanelState {
  sessionId: string;
  container: HTMLElement;
  status: GitStatusResponse | null;
  expandedSections: Set<PanelSectionId>;
}

const panelStates = new Map<string, GitPanelState>();

export function createGitPanel(container: HTMLElement, sessionId: string): void {
  const state: GitPanelState = {
    sessionId,
    container,
    status: null,
    expandedSections: new Set<PanelSectionId>(),
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
      expandedSections: new Set<PanelSectionId>(),
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
    case 'renamed':
      return 'R';
    case 'conflicted':
      return '!';
    default:
      return 'M';
  }
}

function statusToColor(status: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'green';
    case 'deleted':
    case 'conflicted':
      return 'red';
    default:
      return 'yellow';
  }
}

function hasGitRepoStatus(status: GitStatusResponse | null): status is GitStatusResponse {
  return Boolean(status && (status.repoRoot || status.branch));
}

function countWorktreeChanges(status: GitStatusResponse): number {
  return (
    status.conflicted.length +
    status.staged.length +
    status.modified.length +
    status.untracked.length
  );
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
      const part = parts[i];
      if (part === undefined) continue;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          file: null,
        });
      }
      const child = node.children.get(part);
      if (!child) continue;
      node = child;
    }
    const fileName = parts[parts.length - 1];
    if (fileName === undefined) continue;
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
      const isDisabled = child.file.status === 'untracked';
      html += `<div class="git-tree-file${isDisabled ? ' git-tree-file-disabled' : ''}" data-path="${escapeHtml(child.file.path)}" style="padding-left:${12 + indent}px">
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
    add += f.additions;
    del += f.deletions;
  }
  return { add, del };
}

function applyDefaultExpandedSections(state: GitPanelState, status: GitStatusResponse): void {
  if (state.expandedSections.size > 0) {
    return;
  }

  const sections: SectionId[] = [];

  if (status.conflicted.length > 0) {
    sections.push('conflicts');
  }
  if (status.staged.length > 0) {
    sections.push('staged');
  }
  if (status.modified.length > 0) {
    sections.push('changes');
  }
  if (status.untracked.length > 0) {
    sections.push('untracked');
  }

  if (sections.length === 0 && status.recentCommits.length > 0) {
    state.expandedSections.add('commits');
    return;
  }

  for (const section of sections) {
    state.expandedSections.add(section);
  }
}

function renderPanelFill(mainText: string, hintText = '', className = ''): string {
  return `<div class="git-panel-fill${className ? ' ' + className : ''}">
    <div class="git-panel-empty-copy">
      <p>${escapeHtml(mainText)}</p>
      ${hintText ? `<p class="git-panel-hint">${escapeHtml(hintText)}</p>` : ''}
    </div>
  </div>`;
}

function renderSummary(status: GitStatusResponse): string {
  const pills: string[] = [];
  const changeCount = countWorktreeChanges(status);

  if (status.conflicted.length > 0) {
    pills.push(
      `<span class="git-summary-pill git-summary-pill-danger">!${status.conflicted.length}</span>`,
    );
  }
  if (changeCount > 0) {
    pills.push(`<span class="git-summary-pill git-summary-pill-warn">~${changeCount}</span>`);
  }
  if (status.ahead > 0) {
    pills.push(`<span class="git-summary-pill">↑${status.ahead}</span>`);
  }
  if (status.behind > 0) {
    pills.push(`<span class="git-summary-pill">↓${status.behind}</span>`);
  }
  if (status.stashCount > 0) {
    pills.push(
      `<span class="git-summary-pill">${escapeHtml(t('git.stash'))} ${status.stashCount}</span>`,
    );
  }
  if (pills.length === 0) {
    pills.push(
      `<span class="git-summary-pill git-summary-pill-clean">${escapeHtml(t('git.cleanShort'))}</span>`,
    );
  }

  const branch = escapeHtml(status.branch || 'HEAD');
  const repoRoot = escapeHtml(status.repoRoot);
  const repoSubtitle = status.repoRoot
    ? `<div class="git-panel-summary-subtitle" title="${repoRoot}">${repoRoot}</div>`
    : '';

  return `<div class="git-panel-summary">
    <div class="git-panel-summary-title-row">
      <span class="git-panel-summary-title">${branch}</span>
      <span class="git-panel-summary-pills">${pills.join('')}</span>
    </div>
    ${repoSubtitle}
  </div>`;
}

function renderPanel(state: GitPanelState): void {
  const { status, container } = state;

  if (!hasGitRepoStatus(status)) {
    container.innerHTML = `
      <div class="git-panel">
        <div class="git-panel-content">
          ${renderPanelFill(t('git.notARepo'), t('git.notARepoHint'), 'git-panel-empty')}
        </div>
      </div>`;
    return;
  }

  applyDefaultExpandedSections(state, status);

  const hasConflicts = status.conflicted.length > 0;
  const hasStaged = status.staged.length > 0;
  const hasChanges = status.modified.length > 0;
  const hasUntracked = status.untracked.length > 0;
  const sectionCount = [hasConflicts, hasStaged, hasChanges, hasUntracked].filter(Boolean).length;
  const singleFillSection = sectionCount === 1;

  let html = '<div class="git-panel">';
  html += renderSummary(status);
  html += '<div class="git-panel-content">';

  if (sectionCount > 0) {
    html += `<div class="git-panel-sections${singleFillSection ? ' git-panel-sections-fill' : ''}">`;
    if (hasConflicts) {
      html += renderSection(
        state,
        'conflicts',
        t('git.conflicts'),
        status.conflicted,
        singleFillSection,
      );
    }
    if (hasStaged) {
      html += renderSection(
        state,
        'staged',
        t('git.stagedChanges'),
        status.staged,
        singleFillSection,
      );
    }
    if (hasChanges) {
      html += renderSection(state, 'changes', t('git.changes'), status.modified, singleFillSection);
    }
    if (hasUntracked) {
      html += renderSection(
        state,
        'untracked',
        t('git.untracked'),
        status.untracked,
        singleFillSection,
      );
    }
    html += '</div>';
  } else {
    html += renderPanelFill(t('git.workingTreeClean'), '', 'git-panel-clean');
  }

  if (status.recentCommits.length > 0) {
    html += renderCommitsSection(state, status.recentCommits, sectionCount === 0);
  }

  html += '</div></div>';
  container.innerHTML = html;
  bindPanelEvents(state);
}

function renderSection(
  state: GitPanelState,
  sectionId: SectionId,
  title: string,
  files: GitFileEntry[],
  fill = false,
): string {
  const isExpanded = state.expandedSections.has(sectionId);
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

  let html = `<div class="git-section${isExpanded ? ' git-section-expanded' : ''}${fill ? ' git-section-fill' : ''}">
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

function renderCommitsSection(state: GitPanelState, commits: GitLogEntry[], fill = false): string {
  if (commits.length === 0) return '';

  const isExpanded = state.expandedSections.has('commits');

  let html = `<div class="git-commits-section${fill ? ' git-commits-fill' : ''}">
    <button class="git-section-toggle" data-section="commits">
      ${t('git.recentCommits')} (${commits.length})
      <span class="git-section-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
    </button>`;

  if (isExpanded) {
    html += '<div class="git-commits-list">';
    for (const commit of commits) {
      const metaParts = [commit.author, commit.date]
        .filter((part) => part.length > 0)
        .map((part) => escapeHtml(part));
      const metaHtml =
        metaParts.length > 0 ? `<div class="git-commit-meta">${metaParts.join(' • ')}</div>` : '';

      html += `<div class="git-commit-entry">
        <div class="git-commit-main">
          <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
          <span class="git-commit-msg">${escapeHtml(commit.message)}</span>
        </div>
        ${metaHtml}
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
      if (state.expandedSections.has(section)) {
        state.expandedSections.delete(section);
      } else {
        state.expandedSections.add(section);
      }
      renderPanel(state);
    });
  });

  container.querySelectorAll<HTMLElement>('.git-section-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      const section = el.dataset.section as PanelSectionId;
      if (state.expandedSections.has(section)) {
        state.expandedSections.delete(section);
      } else {
        state.expandedSections.add(section);
      }
      renderPanel(state);
    });
  });

  container.querySelectorAll<HTMLElement>('.git-tree-file').forEach((el) => {
    el.addEventListener('click', () => {
      const path = el.dataset.path;
      if (!path || !status) return;

      if (el.classList.contains('git-tree-file-disabled')) {
        return;
      }

      const isStaged = status.staged.some((f) => f.path === path);

      void openDiffOverlay(sessionId, path, isStaged);
    });
  });
}
