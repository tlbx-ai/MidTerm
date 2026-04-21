/**
 * Git Panel
 *
 * Accordion-style git status viewer with a dock-native diff/commit inspector
 * and explicit terminal command handoff helpers.
 */

import type {
  GitCommitDetailsResponse,
  GitDiffFileView,
  GitDiffViewResponse,
  GitFileEntry,
  GitLogEntry,
  GitStatusResponse,
} from './types';
import { fetchCommitDetails, fetchDiffView, fetchGitLog, fetchGitStatus } from './gitApi';
import { buildCommitCommandSuggestions, buildFileCommandSuggestions } from './gitCommands';
import { submitSessionText } from '../input/submit';
import { escapeHtml } from '../../utils';
import { t } from '../i18n';

type SectionId = 'conflicts' | 'staged' | 'changes' | 'untracked';
type PanelSectionId = SectionId | 'commits';
type FileScope = 'worktree' | 'staged';

interface GitFileSelection {
  kind: 'file';
  path: string;
  scope: FileScope;
  status: string;
  originalPath?: string | undefined;
  diff: GitDiffViewResponse | null;
  loading: boolean;
  error: string | null;
}

interface GitCommitSelection {
  kind: 'commit';
  hash: string;
  details: GitCommitDetailsResponse | null;
  loading: boolean;
  error: string | null;
}

type GitSelection = GitFileSelection | GitCommitSelection | null;

interface GitPanelState {
  sessionId: string;
  container: HTMLElement;
  status: GitStatusResponse | null;
  expandedSections: Set<PanelSectionId>;
  selection: GitSelection;
  historyEntries: GitLogEntry[];
  historyCount: number;
  hasMoreHistory: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: GitFileEntry | null;
  scope: FileScope;
}

const panelStates = new Map<string, GitPanelState>();
const HISTORY_PAGE_SIZE = 20;

export function createGitPanel(container: HTMLElement, sessionId: string): void {
  const state = createPanelState(container, sessionId);
  panelStates.set(sessionId, state);
  renderPanel(state);
}

export function updateGitStatus(sessionId: string, status: GitStatusResponse): void {
  const state = panelStates.get(sessionId);
  if (!state) return;
  state.status = status;
  syncHistoryFromStatus(state, status);
  syncSelectionAfterStatus(state);
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
    state = createPanelState(container, sessionId);
    panelStates.set(sessionId, state);
  } else {
    state.container = container;
  }

  const status = await fetchGitStatus(sessionId);
  if (status) {
    state.status = status;
    syncHistoryFromStatus(state, status);
    syncSelectionAfterStatus(state);
  }

  renderPanel(state);
}

export async function showCommitInGitPanel(sessionId: string, hash: string): Promise<void> {
  let state = panelStates.get(sessionId);
  if (!state) {
    const container = document.getElementById('git-dock')?.querySelector('.git-dock-body');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    await renderGitPanelInto(container, sessionId);
    state = panelStates.get(sessionId);
    if (!state) {
      return;
    }
  }

  await openCommitSelection(state, hash);
}

export function destroyGitPanel(sessionId: string): void {
  panelStates.delete(sessionId);
}

function createPanelState(container: HTMLElement, sessionId: string): GitPanelState {
  return {
    sessionId,
    container,
    status: null,
    expandedSections: new Set<PanelSectionId>(),
    selection: null,
    historyEntries: [],
    historyCount: HISTORY_PAGE_SIZE,
    hasMoreHistory: false,
  };
}

function syncHistoryFromStatus(state: GitPanelState, status: GitStatusResponse): void {
  const currentHead = state.historyEntries[0]?.hash;
  const nextHead = status.recentCommits[0]?.hash;
  const shouldReset =
    state.historyEntries.length === 0 ||
    state.historyEntries.length <= status.recentCommits.length ||
    (currentHead && nextHead && currentHead !== nextHead);

  if (shouldReset) {
    state.historyEntries = status.recentCommits;
    state.historyCount = Math.max(HISTORY_PAGE_SIZE, status.recentCommits.length);
    state.hasMoreHistory = status.recentCommits.length >= HISTORY_PAGE_SIZE;
  }
}

function syncSelectionAfterStatus(state: GitPanelState): void {
  if (!hasGitRepoStatus(state.status) || !state.selection) {
    state.selection = null;
    return;
  }

  if (state.selection.kind !== 'file') {
    return;
  }

  const selection = state.selection;
  const status = state.status;
  const files = getAllFiles(status);
  const exists = files.some(
    (entry) =>
      entry.path === selection.path &&
      (selection.scope === 'staged'
        ? status.staged.some((staged) => staged.path === entry.path)
        : true),
  );

  if (!exists) {
    state.selection = null;
  }
}

function getAllFiles(status: GitStatusResponse): GitFileEntry[] {
  return [...status.conflicted, ...status.staged, ...status.modified, ...status.untracked];
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
    case 'unmerged':
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
    case 'unmerged':
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

function buildFileTree(files: GitFileEntry[], scope: FileScope): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), file: null, scope };
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
          scope,
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
      scope,
    });
  }
  return root;
}

function renderTreeNode(node: TreeNode, depth: number, selection: GitSelection): string {
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
      const isSelected =
        selection?.kind === 'file' &&
        selection.path === child.file.path &&
        selection.scope === child.scope;
      html += `<button class="git-tree-file${isSelected ? ' git-tree-file-selected' : ''}" data-action="open-file" data-path="${escapeHtml(child.file.path)}" data-status="${escapeHtml(child.file.status)}" data-scope="${child.scope}"${child.file.originalPath ? ` data-original-path="${escapeHtml(child.file.originalPath)}"` : ''} style="padding-left:${12 + indent}px" type="button">
        <span class="git-tree-name">${escapeHtml(child.name)}</span>
        <span class="git-file-loc"><span class="git-loc-add">+${child.file.additions}</span> <span class="git-loc-del">-${child.file.deletions}</span></span>
        <span class="git-file-indicator git-indicator-${color}">${letter}</span>
      </button>`;
    } else {
      html += `<div class="git-tree-dir" style="padding-left:${12 + indent}px">
        <span class="git-tree-dir-name">${escapeHtml(child.name)}/</span>
      </div>`;
      html += renderTreeNode(child, depth + 1, selection);
    }
  }
  return html;
}

function tallyLoc(files: GitFileEntry[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const file of files) {
    add += file.additions;
    del += file.deletions;
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

  if (sections.length === 0 && state.historyEntries.length > 0) {
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
    state.selection = null;
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

  let html = `<div class="git-panel-shell${state.selection ? ' git-panel-detail-active' : ''}">`;
  html += '<div class="git-panel-list">';
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
        'worktree',
        singleFillSection,
      );
    }
    if (hasStaged) {
      html += renderSection(
        state,
        'staged',
        t('git.stagedChanges'),
        status.staged,
        'staged',
        singleFillSection,
      );
    }
    if (hasChanges) {
      html += renderSection(
        state,
        'changes',
        t('git.changes'),
        status.modified,
        'worktree',
        singleFillSection,
      );
    }
    if (hasUntracked) {
      html += renderSection(
        state,
        'untracked',
        t('git.untracked'),
        status.untracked,
        'worktree',
        singleFillSection,
      );
    }
    html += '</div>';
  } else {
    html += renderPanelFill(t('git.workingTreeClean'), '', 'git-panel-clean');
  }

  if (state.historyEntries.length > 0) {
    html += renderCommitsSection(state, sectionCount === 0);
  }

  html += '</div></div>';
  html += renderInspector(state);
  html += '</div>';

  container.innerHTML = html;
  bindPanelEvents(state);
}

function renderSection(
  state: GitPanelState,
  sectionId: SectionId,
  title: string,
  files: GitFileEntry[],
  scope: FileScope,
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
    <button class="git-section-header" data-action="toggle-section" data-section="${sectionId}" type="button">
      <span class="git-section-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
      <span class="git-section-title">${escapeHtml(title)}</span>
      <span class="git-section-count">${count}</span>
      ${locHtml}
    </button>`;

  if (isExpanded) {
    const tree = buildFileTree(files, scope);
    html += `<div class="git-section-body">`;
    html += renderTreeNode(tree, 0, state.selection);
    html += `</div>`;
  }

  html += '</div>';
  return html;
}

function renderCommitsSection(state: GitPanelState, fill = false): string {
  const commits = state.historyEntries;
  if (commits.length === 0) return '';

  const isExpanded = state.expandedSections.has('commits');

  let html = `<div class="git-commits-section${fill ? ' git-commits-fill' : ''}">
    <button class="git-section-toggle" data-action="toggle-section" data-section="commits" type="button">
      ${t('git.recentCommits')} (${commits.length})
      <span class="git-section-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
    </button>`;

  if (isExpanded) {
    html += '<div class="git-commits-list">';
    for (const commit of commits) {
      const metaParts = [commit.author, formatDate(commit.date)]
        .filter((part) => part.length > 0)
        .map((part) => escapeHtml(part));
      const metaHtml =
        metaParts.length > 0 ? `<div class="git-commit-meta">${metaParts.join(' | ')}</div>` : '';
      const isSelected = state.selection?.kind === 'commit' && state.selection.hash === commit.hash;

      html += `<button class="git-commit-entry${isSelected ? ' git-commit-entry-selected' : ''}" data-action="open-commit" data-hash="${escapeHtml(commit.hash)}" type="button">
        <div class="git-commit-main">
          <span class="git-commit-hash">${escapeHtml(commit.shortHash)}</span>
          <span class="git-commit-msg">${escapeHtml(commit.message)}</span>
        </div>
        ${metaHtml}
      </button>`;
    }
    if (state.hasMoreHistory) {
      html += `<button class="git-history-more" data-action="load-more-history" type="button">Load more history</button>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderInspector(state: GitPanelState): string {
  const selection = state.selection;
  let body = `<div class="git-inspector-empty">
    <p>Select a file or commit to inspect changes.</p>
    <p class="git-panel-hint">Use the dock for review, then hand off write commands to the terminal.</p>
  </div>`;

  if (selection?.kind === 'file') {
    body = renderFileInspector(selection);
  } else if (selection?.kind === 'commit') {
    body = renderCommitInspector(selection);
  }

  return `<div class="git-panel-inspector">
    <div class="git-inspector-header">
      <button class="git-inspector-back" data-action="clear-selection" type="button">Back</button>
    </div>
    <div class="git-inspector-body">${body}</div>
  </div>`;
}

function renderFileInspector(selection: GitFileSelection): string {
  if (selection.loading) {
    return renderInspectorFill('Loading diff...');
  }

  if (selection.error) {
    return renderInspectorFill(selection.error);
  }

  const diff = selection.diff;
  const file =
    diff?.files.find((candidate) => candidate.path === selection.path) ??
    createFallbackDiffFile(selection);

  const suggestions = buildFileCommandSuggestions(file, selection.scope);
  const pathHtml = escapeHtml(file.path);
  const originalHtml = file.originalPath
    ? `<div class="git-inspector-subtitle">from ${escapeHtml(file.originalPath)}</div>`
    : '';

  let html = `<div class="git-inspector-summary">
    <div class="git-inspector-title-row">
      <span class="git-inspector-title" title="${pathHtml}">${pathHtml}</span>
      <span class="git-summary-pill">${escapeHtml(selection.scope)}</span>
    </div>
    ${originalHtml}
  </div>`;
  html += renderPatchFile(file);
  html += renderCommandSuggestions(suggestions);
  return html;
}

function renderCommitInspector(selection: GitCommitSelection): string {
  if (selection.loading) {
    return renderInspectorFill('Loading commit...');
  }

  if (selection.error || !selection.details) {
    return renderInspectorFill(selection.error ?? 'Commit details unavailable.');
  }

  const commit = selection.details;
  const suggestions = buildCommitCommandSuggestions(commit);
  const bodyHtml = commit.body.trim()
    ? `<pre class="git-commit-body">${escapeHtml(commit.body.trim())}</pre>`
    : '';
  const parentsHtml =
    commit.parentHashes.length > 0
      ? `<div class="git-commit-detail-row"><span class="git-commit-detail-label">Parents</span><span>${escapeHtml(commit.parentHashes.join(' '))}</span></div>`
      : '';

  let html = `<div class="git-inspector-summary">
    <div class="git-inspector-title-row">
      <span class="git-inspector-title">${escapeHtml(commit.subject || commit.shortHash)}</span>
      <span class="git-summary-pill">${escapeHtml(commit.shortHash)}</span>
    </div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Author</span><span>${escapeHtml(commit.author)}</span></div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Authored</span><span>${escapeHtml(formatDate(commit.authoredDate))}</span></div>
    <div class="git-commit-detail-row"><span class="git-commit-detail-label">Committed</span><span>${escapeHtml(formatDate(commit.committedDate))}</span></div>
    ${parentsHtml}
  </div>`;
  html += bodyHtml;
  html += `<div class="git-commit-patch-list">${commit.files.map((file) => renderPatchFile(file)).join('')}</div>`;
  html += renderCommandSuggestions(suggestions);
  return html;
}

function renderPatchFile(file: GitDiffFileView): string {
  const title = escapeHtml(file.path);
  const subtitle = file.originalPath
    ? `<div class="git-inspector-subtitle">from ${escapeHtml(file.originalPath)}</div>`
    : '';

  const body = file.isBinary
    ? `<div class="git-patch-empty">Binary file changed.</div>`
    : file.hunks.length === 0
      ? `<div class="git-patch-empty">No patch text available.</div>`
      : file.hunks
          .map((hunk) => {
            const lines = hunk.lines
              .map(
                (line) =>
                  `<span class="git-diff-line git-diff-line-${escapeHtml(line.kind)}">${escapeHtml(line.text)}</span>`,
              )
              .join('\n');
            return `<section class="git-diff-hunk-block">
          <div class="git-diff-hunk-header">${escapeHtml(hunk.header)}</div>
          <pre class="git-diff-lines">${lines}</pre>
        </section>`;
          })
          .join('');

  const truncatedHtml = file.isTruncated
    ? `<div class="git-panel-hint">Patch output was truncated.</div>`
    : '';

  return `<section class="git-inspector-patch">
    <div class="git-inspector-file-header">
      <div>
        <div class="git-inspector-file-title">${title}</div>
        ${subtitle}
      </div>
      <div class="git-file-loc"><span class="git-loc-add">+${file.additions}</span> <span class="git-loc-del">-${file.deletions}</span></div>
    </div>
    ${body}
    ${truncatedHtml}
  </section>`;
}

function renderCommandSuggestions(suggestions: Array<{ label: string; command: string }>): string {
  return `<section class="git-command-section">
    <div class="git-command-section-title">Suggested terminal commands</div>
    <div class="git-command-list">
      ${suggestions
        .map(
          (suggestion) => `<div class="git-command-row">
            <div class="git-command-copy">
              <div class="git-command-label">${escapeHtml(suggestion.label)}</div>
              <code class="git-command-text">${escapeHtml(suggestion.command)}</code>
            </div>
            <div class="git-command-actions">
              <button class="sidebar-btn" data-action="copy-command" data-command="${escapeHtml(suggestion.command)}" title="Copy" type="button">Copy</button>
              <button class="sidebar-btn" data-action="send-command" data-command="${escapeHtml(suggestion.command)}" title="Send to terminal" type="button">Send</button>
            </div>
          </div>`,
        )
        .join('')}
    </div>
  </section>`;
}

function renderInspectorFill(message: string): string {
  return `<div class="git-inspector-empty"><p>${escapeHtml(message)}</p></div>`;
}

function createFallbackDiffFile(selection: GitFileSelection): GitDiffFileView {
  return {
    path: selection.path,
    originalPath: selection.originalPath,
    status: selection.status,
    additions: 0,
    deletions: 0,
    isBinary: false,
    isTruncated: false,
    hunks: [],
  };
}

function bindPanelEvents(state: GitPanelState): void {
  const { container } = state;

  container.querySelectorAll<HTMLElement>('[data-action="toggle-section"]').forEach((el) => {
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

  container.querySelectorAll<HTMLElement>('[data-action="open-file"]').forEach((el) => {
    el.addEventListener('click', () => {
      const path = el.dataset.path;
      const scope = el.dataset.scope as FileScope | undefined;
      const status = el.dataset.status;
      if (!path || !scope || !status) return;
      void openFileSelection(state, {
        path,
        scope,
        status,
        originalPath: el.dataset.originalPath,
      });
    });
  });

  container.querySelectorAll<HTMLElement>('[data-action="open-commit"]').forEach((el) => {
    el.addEventListener('click', () => {
      const hash = el.dataset.hash;
      if (!hash) return;
      void openCommitSelection(state, hash);
    });
  });

  container.querySelectorAll<HTMLElement>('[data-action="load-more-history"]').forEach((el) => {
    el.addEventListener('click', () => {
      void loadMoreHistory(state);
    });
  });

  container.querySelectorAll<HTMLElement>('[data-action="copy-command"]').forEach((el) => {
    el.addEventListener('click', () => {
      const command = el.dataset.command;
      if (!command || typeof navigator.clipboard === 'undefined') return;
      void navigator.clipboard.writeText(command).catch(() => {});
    });
  });

  container.querySelectorAll<HTMLElement>('[data-action="send-command"]').forEach((el) => {
    el.addEventListener('click', () => {
      const command = el.dataset.command;
      if (!command) return;
      void submitSessionText(state.sessionId, command).catch(() => {});
    });
  });

  container.querySelectorAll<HTMLElement>('[data-action="clear-selection"]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selection = null;
      renderPanel(state);
    });
  });
}

async function openFileSelection(
  state: GitPanelState,
  selection: Pick<GitFileSelection, 'path' | 'scope' | 'status' | 'originalPath'>,
): Promise<void> {
  const existing = getExistingFileSelection(state, selection);

  if (existing && !existing.loading && existing.diff) {
    renderPanel(state);
    return;
  }

  state.selection = createLoadingFileSelection(selection, existing?.diff ?? null);
  renderPanel(state);

  if (selection.status === 'untracked') {
    state.selection = createUntrackedFileSelection(selection);
    renderPanel(state);
    return;
  }

  const diff = await fetchDiffView(state.sessionId, selection.path, selection.scope);
  const currentSelection = panelStates.get(state.sessionId)?.selection;
  if (
    !currentSelection ||
    currentSelection.kind !== 'file' ||
    currentSelection.path !== selection.path ||
    currentSelection.scope !== selection.scope
  ) {
    return;
  }

  state.selection = createResolvedFileSelection(selection, currentSelection, diff);
  renderPanel(state);
}

function getExistingFileSelection(
  state: GitPanelState,
  selection: Pick<GitFileSelection, 'path' | 'scope'>,
): GitFileSelection | null {
  return state.selection?.kind === 'file' &&
    state.selection.path === selection.path &&
    state.selection.scope === selection.scope
    ? state.selection
    : null;
}

function createLoadingFileSelection(
  selection: Pick<GitFileSelection, 'path' | 'scope' | 'status' | 'originalPath'>,
  diff: GitFileSelection['diff'],
): GitFileSelection {
  return {
    kind: 'file',
    path: selection.path,
    scope: selection.scope,
    status: selection.status,
    originalPath: selection.originalPath,
    diff,
    loading: true,
    error: null,
  };
}

function createUntrackedFileSelection(
  selection: Pick<GitFileSelection, 'path' | 'scope' | 'status' | 'originalPath'>,
): GitFileSelection {
  const fileSelection = createLoadingFileSelection(selection, null);
  return {
    ...fileSelection,
    diff: {
      scope: selection.scope,
      title: 'Working tree diff',
      isTruncated: false,
      files: [createFallbackDiffFile(fileSelection)],
    },
    loading: false,
  };
}

function createResolvedFileSelection(
  selection: Pick<GitFileSelection, 'path' | 'scope' | 'status' | 'originalPath'>,
  currentSelection: GitFileSelection,
  diff: GitDiffViewResponse | null,
): GitFileSelection {
  return {
    kind: 'file',
    path: selection.path,
    scope: selection.scope,
    status: selection.status,
    originalPath: selection.originalPath,
    diff:
      diff && diff.files.length > 0
        ? diff
        : {
            scope: selection.scope,
            title: selection.scope === 'staged' ? 'Staged diff' : 'Working tree diff',
            isTruncated: false,
            files: [createFallbackDiffFile(currentSelection)],
          },
    loading: false,
    error: diff ? null : 'Unable to load diff.',
  };
}

async function openCommitSelection(state: GitPanelState, hash: string): Promise<void> {
  const existing =
    state.selection?.kind === 'commit' && state.selection.hash === hash ? state.selection : null;

  if (existing && !existing.loading && existing.details) {
    renderPanel(state);
    return;
  }

  state.selection = {
    kind: 'commit',
    hash,
    details: existing?.details ?? null,
    loading: true,
    error: null,
  };
  renderPanel(state);

  const details = await fetchCommitDetails(state.sessionId, hash);
  const currentSelection = panelStates.get(state.sessionId)?.selection;
  if (!currentSelection || currentSelection.kind !== 'commit' || currentSelection.hash !== hash) {
    return;
  }

  state.selection = {
    kind: 'commit',
    hash,
    details,
    loading: false,
    error: details ? null : 'Unable to load commit details.',
  };
  renderPanel(state);
}

async function loadMoreHistory(state: GitPanelState): Promise<void> {
  const nextCount = state.historyCount + HISTORY_PAGE_SIZE;
  const entries = await fetchGitLog(state.sessionId, nextCount);
  if (entries.length === 0) {
    state.hasMoreHistory = false;
    renderPanel(state);
    return;
  }

  state.historyEntries = entries;
  state.historyCount = nextCount;
  state.hasMoreHistory = entries.length >= nextCount;
  renderPanel(state);
}

function formatDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
