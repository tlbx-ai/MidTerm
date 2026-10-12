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
  GitOperationRequest,
} from './types';
import type { Session } from '../../types';
import { fetchCommitDetails, fetchDiffView, fetchGitLog, fetchGitStatus } from './gitApi';
import { buildCommitCommandSuggestions, buildFileCommandSuggestions } from './gitCommands';
import { pasteToTerminal } from '../terminal';
import { escapeHtml } from '../../utils';
import { renderPatchFile } from './gitDiffView';
import { t } from '../i18n';
import { areJsonLikeEqual, $sessions } from '../../stores';
import { syncGitPanelDom } from './gitPanelDom';
import { showPathDetails, repositoryFilePath } from '../fileViewer/pathDetails';
import { fileStatusPresentation } from './fileStatus';
import { writeTextToClipboard } from '../fileViewer/shared';
import { sessionTerminals } from '../../state';
import { addProcessStateListener, getProcessState } from '../process';
import {
  createGitOperationsUi,
  renderGitOperations,
  gitFileAction,
  gitSectionAction,
  executeGitOperation,
  setGitCommitMessage,
  canCommit,
  type GitOperationsUi,
} from './gitOperations';
import {
  connectGitPanelLayout,
  disconnectGitPanelLayout,
  focusGitSelection,
  type GitPanelLayoutState,
} from './gitPanelLayout';

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

interface GitPanelState extends GitPanelLayoutState {
  operations: GitOperationsUi;
  wrapDiff: boolean;
  sessionId: string;
  repoRoot?: string | undefined;
  container: HTMLElement;
  status: GitStatusResponse | null;
  expandedSections: Set<PanelSectionId>;
  selection: GitSelection;
  historyEntries: GitLogEntry[];
  historyCount: number;
  hasMoreHistory: boolean;
  inspectorSelection?: GitSelection;
  inspectorHtml?: string;
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
const DIFF_WRAP_KEY = 'tlbx-git-diff-wrap';
const nowrapScroll = new WeakMap<HTMLElement, number>();
// Only one panel may own a shared dock body, including while fetches are pending.
const activePanels = new WeakMap<HTMLElement, GitPanelState>();
const boundPanelContainers = new WeakSet<HTMLElement>();

addProcessStateListener((sessionId) => {
  for (const state of panelStates.values()) {
    if (state.sessionId !== sessionId || activePanels.get(state.container) !== state) continue;
    const allowed = canInsertCommand(sessionId);
    for (const button of state.container.querySelectorAll<HTMLButtonElement>(
      '[data-action="insert-command"]',
    )) {
      button.disabled = !allowed || button.getAttribute('aria-busy') === 'true';
      button.title = t(allowed ? 'git.insertHint' : 'git.insertShellOnly');
    }
  }
});

export function suspendGitPanel(container: HTMLElement): void {
  disconnectGitPanelLayout(container);
  activePanels.delete(container);
}

export function createGitPanel(container: HTMLElement, sessionId: string, repoRoot?: string): void {
  const state = createPanelState(container, sessionId, repoRoot);
  panelStates.set(getPanelKey(sessionId, repoRoot), state);
  activePanels.set(container, state);
  renderPanel(state);
}

export function updateGitStatus(sessionId: string, status: GitStatusResponse): void {
  const explicit = panelStates.get(getPanelKey(sessionId, status.repoRoot));
  const implicit = panelStates.get(sessionId);
  const states = new Set([
    explicit,
    implicit?.status?.repoRoot === status.repoRoot ? implicit : undefined,
  ]);
  for (const state of states) {
    if (!state || areJsonLikeEqual(state.status, status)) continue;
    const indexChanged = state.status?.indexVersion !== status.indexVersion;
    state.status = status;
    syncHistoryFromStatus(state, status);
    syncSelectionAfterStatus(state);
    renderPanel(state);
    if (indexChanged && state.selection?.kind === 'file')
      void openFileSelection(state, state.selection, true);
  }
}

export async function refreshGitPanel(sessionId: string, repoRoot?: string): Promise<void> {
  const status = await fetchGitStatus(sessionId, repoRoot);
  if (status) {
    updateGitStatus(sessionId, status);
  }
}

export async function renderGitPanelInto(
  container: HTMLElement,
  sessionId: string,
  repoRoot?: string,
): Promise<void> {
  const key = getPanelKey(sessionId, repoRoot);
  let state = panelStates.get(key);
  if (!state) {
    state = createPanelState(container, sessionId, repoRoot);
    panelStates.set(key, state);
  } else {
    state.container = container;
    state.repoRoot = repoRoot;
  }

  activePanels.set(container, state);
  // Paint cached state now and do not overwrite a newer pushed status with a slow fetch.
  renderPanel(state);
  const previousStatus = state.status;
  const status = await fetchGitStatus(sessionId, repoRoot);
  if (status && state.status === previousStatus) {
    state.status = status;
    syncHistoryFromStatus(state, status);
    syncSelectionAfterStatus(state);
  }

  renderPanel(state);
}

export async function showCommitInGitPanel(
  sessionId: string,
  hash: string,
  repoRoot?: string,
): Promise<void> {
  const key = getPanelKey(sessionId, repoRoot);
  let state = panelStates.get(key);
  if (!state) {
    const container = document.getElementById('git-dock')?.querySelector('.git-dock-body');
    if (!(container instanceof HTMLElement)) {
      return;
    }

    await renderGitPanelInto(container, sessionId, repoRoot);
    state = panelStates.get(key);
    if (!state) {
      return;
    }
  }

  await openCommitSelection(state, hash);
}

export function destroyGitPanel(sessionId: string): void {
  for (const key of panelStates.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}|`)) {
      const state = panelStates.get(key);
      if (state && activePanels.get(state.container) === state) {
        disconnectGitPanelLayout(state.container);
        activePanels.delete(state.container);
      }
      panelStates.delete(key);
    }
  }
}

function createPanelState(
  container: HTMLElement,
  sessionId: string,
  repoRoot?: string,
): GitPanelState {
  return {
    sessionId,
    repoRoot,
    container,
    status: null,
    expandedSections: new Set<PanelSectionId>(),
    selection: null,
    operations: createGitOperationsUi(sessionId, repoRoot),
    wrapDiff: readDiffWrap(),
    detailActive: true,
    scrollPositions: new Map(),
    historyEntries: [],
    historyCount: HISTORY_PAGE_SIZE,
    hasMoreHistory: false,
  };
}

function readDiffWrap(): boolean {
  try {
    return localStorage.getItem(DIFF_WRAP_KEY) === 'true';
  } catch {
    return false;
  }
}

function toggleDiffWrap(state: GitPanelState): void {
  const panes = state.container.querySelectorAll<HTMLElement>('.git-diff-lines');
  state.wrapDiff = !state.wrapDiff;
  if (state.wrapDiff) for (const pane of panes) nowrapScroll.set(pane, pane.scrollLeft);
  const shell = state.container.querySelector<HTMLElement>('.git-panel-shell');
  if (shell) shell.dataset.diffWrap = String(state.wrapDiff);
  if (!state.wrapDiff) for (const pane of panes) pane.scrollLeft = nowrapScroll.get(pane) ?? 0;
  state.container
    .querySelector('[data-action="toggle-diff-wrap"]')
    ?.setAttribute('aria-pressed', String(state.wrapDiff));
  try {
    localStorage.setItem(DIFF_WRAP_KEY, String(state.wrapDiff));
  } catch {
    /* The current reading mode still works without storage. */
  }
}

function getPanelKey(sessionId: string, repoRoot?: string): string {
  return repoRoot ? `${sessionId}|${repoRoot}` : sessionId;
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
  const workingFiles = [...status.conflicted, ...status.modified, ...status.untracked];
  let scope = selection.scope;
  let entry = (scope === 'staged' ? status.staged : workingFiles).find(
    (file) => file.path === selection.path,
  );
  if (!entry) {
    scope = scope === 'staged' ? 'worktree' : 'staged';
    entry = (scope === 'staged' ? status.staged : workingFiles).find(
      (file) => file.path === selection.path,
    );
  }
  if (!entry) {
    state.selection = null;
  } else if (
    scope !== selection.scope ||
    entry.status !== selection.status ||
    entry.originalPath !== selection.originalPath
  ) {
    state.selection = {
      ...selection,
      scope,
      status: entry.status,
      originalPath: entry.originalPath,
    };
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

function panelShellClass(state: GitPanelState): string {
  return `git-panel-shell${state.selection && state.detailActive ? ' git-panel-detail-active' : ''}`;
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

function renderTreeNode(
  node: TreeNode,
  depth: number,
  selection: GitSelection,
  repoRoot: string,
  busy: boolean,
): string {
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
      const presentation = fileStatusPresentation(child.file.status);
      const statusId = `git-file-status-${encodeURIComponent(`${repoRoot}:${child.scope}:${child.file.path}`)}`;
      const isSelected =
        selection?.kind === 'file' &&
        selection.path === child.file.path &&
        selection.scope === child.scope;
      const fullPath = escapeHtml(repositoryFilePath(repoRoot, child.file.path));
      html += `<div class="git-tree-file-row" data-path="${escapeHtml(child.file.path)}" data-scope="${child.scope}"><button class="git-tree-file${isSelected ? ' git-tree-file-selected' : ''}" title="${fullPath}" aria-label="${fullPath}"${presentation ? ` aria-describedby="${escapeHtml(statusId)}"` : ''} data-action="open-file" data-path="${escapeHtml(child.file.path)}" data-status="${escapeHtml(child.file.status)}" data-scope="${child.scope}"${child.file.originalPath ? ` data-original-path="${escapeHtml(child.file.originalPath)}"` : ''} style="padding-left:${12 + indent}px" type="button">
        <span class="git-tree-name">${escapeHtml(child.name)}</span>
        ${renderEntryStatistics(child.file)}
        ${presentation ? `<span class="git-file-indicator" id="${escapeHtml(statusId)}" data-git-status="${presentation.status}" role="img" title="${escapeHtml(presentation.label)}" aria-label="${escapeHtml(presentation.label)}">${presentation.letter}</span>` : ''}
      </button>${child.file.status === 'conflicted' ? '' : gitFileAction(child.file.path, child.scope === 'staged', busy)}</div>`;
    } else {
      html += `<div class="git-tree-dir" style="padding-left:${12 + indent}px">
        <span class="git-tree-dir-name">${escapeHtml(child.name)}/</span>
      </div>`;
      html += renderTreeNode(child, depth + 1, selection, repoRoot, busy);
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
  if (activePanels.get(container) !== state) return;

  if (!hasGitRepoStatus(status)) {
    state.selection = null;
    syncGitPanelDom(
      container,
      `
      <div class="git-panel">
        <div class="git-panel-content">
          ${renderPanelFill(t('git.notARepo'), t('git.notARepoHint'), 'git-panel-empty')}
        </div>
      </div>`,
    );
    return;
  }

  applyDefaultExpandedSections(state, status);

  const hasConflicts = status.conflicted.length > 0;
  const hasStaged = status.staged.length > 0;
  const hasChanges = status.modified.length > 0;
  const hasUntracked = status.untracked.length > 0;
  const sectionCount = [hasConflicts, hasStaged, hasChanges, hasUntracked].filter(Boolean).length;
  const singleFillSection = sectionCount === 1;

  let html = `<div class="${panelShellClass(state)}" data-diff-wrap="${state.wrapDiff}">`;
  html += '<div class="git-panel-list">';
  html += renderSummary(status);
  html += renderGitOperations(state.operations, status);
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
  if (state.inspectorHtml === undefined || state.inspectorSelection !== state.selection) {
    state.inspectorHtml = renderInspector(state);
    state.inspectorSelection = state.selection;
  }
  html += '<div class="git-panel-inspector"></div>';
  html += '</div>';

  syncGitPanelDom(container, html);
  syncCommitMessage(container, state.operations.message);
  const inspector = container.querySelector<HTMLElement>('.git-panel-inspector');
  if (inspector) syncGitPanelDom(inspector, state.inspectorHtml);
  container
    .querySelector('[data-action="toggle-diff-wrap"]')
    ?.setAttribute('aria-pressed', String(state.wrapDiff));
  bindPanelEvents(container);
  connectGitPanelLayout(container, () => activePanels.get(container))?.update();
}

function syncCommitMessage(container: HTMLElement, message: string): void {
  const input = container.querySelector<HTMLTextAreaElement>('.git-commit-message');
  if (input && input.value !== message) input.value = message;
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

  let html = `<div data-section="${sectionId}" class="git-section${isExpanded ? ' git-section-expanded' : ''}${fill ? ' git-section-fill' : ''}">
    <div class="git-section-heading"><button class="git-section-header" data-action="toggle-section" data-section="${sectionId}" type="button">
      <span class="git-section-chevron">${isExpanded ? '\u25BE' : '\u25B8'}</span>
      <span class="git-section-title">${escapeHtml(title)}</span>
      <span class="git-section-count">${count}</span>
      ${locHtml}
    </button>${gitSectionAction(sectionId, state.operations.busy || state.operations.pending !== null)}</div>`;

  if (isExpanded) {
    const tree = buildFileTree(files, scope);
    html += `<div class="git-section-body">`;
    html += renderTreeNode(
      tree,
      0,
      state.selection,
      state.status?.repoRoot ?? state.repoRoot ?? '',
      state.operations.busy || state.operations.pending !== null,
    );
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
    body = renderFileInspector(
      selection,
      state.sessionId,
      state.status?.repoRoot ?? state.repoRoot ?? '',
    );
  } else if (selection?.kind === 'commit') {
    body = renderCommitInspector(
      selection,
      state.sessionId,
      state.status?.repoRoot ?? state.repoRoot ?? '',
    );
  }

  return `<div class="git-inspector-header">
      <button class="git-inspector-back" data-action="show-list" type="button">${t('git.backToList')}</button>
      <button class="git-diff-wrap" data-action="toggle-diff-wrap" aria-pressed="${state.wrapDiff}" type="button">${t('git.wrapLines')}</button>
    </div>
    <div class="git-inspector-body">${body}</div>`;
}

function renderFileInspector(selection: GitFileSelection, sessionId: string, root: string): string {
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

  const suggestions = buildFileCommandSuggestions(
    file,
    selection.scope,
    root,
    $sessions.get()[sessionId]?.shellType ?? '',
  );
  const pathHtml = escapeHtml(file.path);
  const originalHtml = file.originalPath
    ? `<div class="git-inspector-subtitle">from ${escapeHtml(file.originalPath)}</div>`
    : '';

  let html = `<div class="git-inspector-summary">
    <div class="git-inspector-title-row">
      <span class="git-inspector-title" title="${pathHtml}">${pathHtml}</span>
      <span class="git-summary-pill">${escapeHtml(selection.scope)}</span>
      <button class="git-path-details" data-action="path-details" data-path="${pathHtml}" data-status="${escapeHtml(selection.status)}"${file.originalPath ? ` data-original-path="${escapeHtml(file.originalPath)}"` : ''} type="button">${t('fileBrowser.details')}</button>
    </div>
    ${originalHtml}
  </div>`;
  html += renderPatchFile(file);
  html += renderCommandSuggestions(suggestions, sessionId);
  return html;
}

function renderCommitInspector(
  selection: GitCommitSelection,
  sessionId: string,
  root: string,
): string {
  if (selection.loading) {
    return renderInspectorFill('Loading commit...');
  }

  if (selection.error || !selection.details) {
    return renderInspectorFill(selection.error ?? 'Commit details unavailable.');
  }

  const commit = selection.details;
  const suggestions = buildCommitCommandSuggestions(
    commit,
    root,
    $sessions.get()[sessionId]?.shellType ?? '',
  );
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
  html += renderCommandSuggestions(suggestions, sessionId);
  return html;
}

function renderEntryStatistics(file: GitFileEntry): string {
  if (file.status === 'untracked') return `<span class="git-file-loc">${t('git.newFile')}</span>`;
  return `<span class="git-file-loc"><span class="git-loc-add">+${file.additions}</span> <span class="git-loc-del">-${file.deletions}</span></span>`;
}

function renderCommandSuggestions(
  suggestions: Array<{ label: string; command: string }>,
  sessionId: string,
): string {
  if (suggestions.length === 0)
    return `<p class="git-panel-hint">${t('git.commandShellUnsupported')}</p>`;
  const insertAllowed = canInsertCommand(sessionId);
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
              <button class="git-action-button" data-action="copy-command" data-command="${escapeHtml(suggestion.command)}" title="${t('git.copyCommand')}" type="button">${t('git.copy')}</button>
              <button class="git-action-button" data-action="insert-command" data-command="${escapeHtml(suggestion.command)}" title="${t(insertAllowed ? 'git.insertHint' : 'git.insertShellOnly')}"${insertAllowed ? '' : ' disabled'} type="button">${t('git.insert')}</button>
            </div>
            <div class="git-action-status" role="status" aria-live="polite"></div>
          </div>`,
        )
        .join('')}
    </div>
  </section>`;
}

function canInsertCommand(sessionId: string): boolean {
  const session = $sessions.get()[sessionId];
  if (
    !session ||
    !session.isRunning ||
    session.appServerControlOnly ||
    !sessionTerminals.has(sessionId)
  )
    return false;
  return isSessionShellForeground(sessionId, session);
}

function isSessionShellForeground(sessionId: string, session: Session): boolean {
  const process = getProcessState(sessionId);
  const foreground = process.foregroundName ?? session.foregroundName;
  const foregroundPid = process.foregroundPid ?? session.foregroundPid;
  const name = foreground?.replace(/\.exe$/i, '').toLowerCase();
  const shell = session.shellType;
  const expected = shell === 'Pwsh' ? 'pwsh' : shell.toLowerCase();
  return (
    (foregroundPid == null && name === undefined) ||
    (foregroundPid === session.pid && (name === 'shell' || name === expected))
  );
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

function bindPanelEvents(container: HTMLElement): void {
  if (boundPanelContainers.has(container)) return;
  boundPanelContainers.add(container);
  container.addEventListener('click', (event) => {
    const state = activePanels.get(container);
    const element =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
    if (!state || !element || !container.contains(element)) return;
    handlePanelAction(state, element);
  });
  container.addEventListener('input', (event) => {
    const state = activePanels.get(container);
    if (
      !state ||
      !(event.target instanceof HTMLTextAreaElement) ||
      event.target.dataset.gitCommitMessage !== 'true'
    )
      return;
    setGitCommitMessage(state.operations, event.target.value);
    const commit = container.querySelector<HTMLButtonElement>('[data-action="commit-staged"]');
    if (commit && state.status) commit.disabled = !canCommit(state.operations, state.status);
  });
  container.addEventListener('keydown', (event) => {
    if (
      !(event.target instanceof HTMLTextAreaElement) ||
      event.target.dataset.gitCommitMessage !== 'true'
    )
      return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      const commit = container.querySelector<HTMLButtonElement>('[data-action="commit-staged"]');
      if (commit && !commit.disabled) commit.click();
    }
  });
}

function handlePanelAction(state: GitPanelState, element: HTMLElement): void {
  const data = element.dataset;
  if (handleMutationAction(state, data)) return;
  switch (data.action) {
    case 'toggle-diff-wrap':
      toggleDiffWrap(state);
      break;
    case 'toggle-section': {
      const section = data.section as PanelSectionId;
      if (state.expandedSections.has(section)) state.expandedSections.delete(section);
      else state.expandedSections.add(section);
      renderPanel(state);
      break;
    }
    case 'open-file':
      openFileFromButton(state, data);
      break;
    case 'open-commit':
      if (data.hash) void openCommitSelection(state, data.hash);
      break;
    case 'path-details': {
      showGitPathDetails(state, data);
      break;
    }
    case 'open-file-viewer':
      void openReviewFileInViewer(state, data.path);
      break;
    case 'load-more-history':
      void loadMoreHistory(state);
      break;
    case 'copy-command':
    case 'insert-command':
      void runPanelCommand(state, element);
      break;
    case 'show-list':
      state.detailActive = false;
      renderPanel(state);
      focusGitSelection(state.container, state);
      break;
    case undefined:
    default:
      break;
  }
}

function handleMutationAction(state: GitPanelState, data: DOMStringMap): boolean {
  if (
    ![
      'stage-file',
      'unstage-file',
      'stage-section',
      'stage-all',
      'unstage-all',
      'commit-staged',
      'retry-operation',
    ].includes(data.action ?? '')
  )
    return false;
  if (state.operations.busy || !state.status) return true;
  if (data.action === 'retry-operation' && state.operations.pending) {
    void performMutation(state, state.operations.pending);
    return true;
  }
  if (state.operations.pending) return true;
  void performMutation(state, buildMutationRequest(state, data, state.status));
  return true;
}

function buildMutationRequest(
  state: GitPanelState,
  data: DOMStringMap,
  status: GitStatusResponse,
): GitOperationRequest {
  let action: GitOperationRequest['action'] =
    data.action === 'commit-staged'
      ? 'commit'
      : data.action?.startsWith('unstage')
        ? 'unstage'
        : 'stage';
  let paths = data.path ? [data.path] : [];
  if (data.action === 'stage-section') {
    const section = data.section as SectionId;
    action = section === 'staged' ? 'unstage' : 'stage';
    const entries =
      section === 'staged'
        ? status.staged
        : section === 'untracked'
          ? status.untracked
          : status.modified;
    paths = entries.map((file) => file.path);
  }
  const root = status.repoRoot;
  const request: GitOperationRequest = {
    sessionId: state.sessionId,
    repoRoot: root,
    operationId: crypto.randomUUID(),
    action,
    paths,
    all: data.action === 'stage-all' || data.action === 'unstage-all',
  };
  if (action === 'commit') {
    request.message = state.operations.message;
    request.expectedIndexVersion = status.indexVersion ?? '';
    request.expectedHead = status.headHash ?? '';
  }
  return request;
}

async function performMutation(state: GitPanelState, request: GitOperationRequest): Promise<void> {
  const pending = executeGitOperation(state.operations, request);
  renderPanel(state);
  const result = await pending;
  if (result?.status) {
    state.status = result.status;
    if (result.state === 'completed' && request.action === 'stage')
      state.expandedSections.add('staged');
    if (result.state === 'completed' && request.action === 'unstage') {
      state.expandedSections.add('changes');
      state.expandedSections.add('untracked');
    }
    syncHistoryFromStatus(state, result.status);
    syncSelectionAfterStatus(state);
  }
  renderPanel(state);
  if (result?.state === 'completed' && state.selection?.kind === 'file')
    await openFileSelection(state, state.selection, true);
}

async function openReviewFileInViewer(state: GitPanelState, path?: string): Promise<void> {
  if (!path || !state.status) return;
  const { openFile } = await import('../fileViewer');
  if (activePanels.get(state.container) !== state) return;
  await openFile(repositoryFilePath(state.status.repoRoot, path));
}

function openFileFromButton(state: GitPanelState, data: DOMStringMap): void {
  if (!data.path || !data.scope || !data.status) return;
  void openFileSelection(state, {
    path: data.path,
    scope: data.scope as FileScope,
    status: data.status,
    originalPath: data.originalPath,
  });
}

function showGitPathDetails(state: GitPanelState, data: DOMStringMap): void {
  const root = state.status?.repoRoot ?? state.repoRoot;
  if (!root || !data.path) return;
  const paths = [repositoryFilePath(root, data.path)];
  if (data.originalPath) paths.push(repositoryFilePath(root, data.originalPath));
  void showPathDetails(paths, [fileStatusPresentation(data.status)?.label ?? '']);
}

async function runPanelCommand(state: GitPanelState, button: HTMLElement): Promise<void> {
  const data = button.dataset;
  if (!data.command) return;
  if (button.getAttribute('aria-busy') === 'true') return;
  const copy = data.action === 'copy-command';
  const status = button
    .closest('.git-command-row')
    ?.querySelector<HTMLElement>('.git-action-status');
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('disabled', '');
  if (status) {
    status.textContent = t(copy ? 'git.copying' : 'git.inserting');
    status.setAttribute('role', 'status');
  }
  let ok = false;
  try {
    if (copy) ok = await writeTextToClipboard(data.command);
    else if (canInsertCommand(state.sessionId)) {
      await pasteToTerminal(state.sessionId, data.command, false, 'git-panel-insert');
      ok = true;
    }
  } catch {
    /* The visible result below reports failure without a false execution claim. */
  }
  if (!button.isConnected) return;
  button.removeAttribute('disabled');
  button.removeAttribute('aria-busy');
  updateCommandResult(status ?? null, copy, ok);
}

function updateCommandResult(status: HTMLElement | null, copy: boolean, ok: boolean): void {
  if (!status) return;
  const success = copy ? 'git.copied' : 'git.inserted';
  const failure = copy ? 'git.copyFailed' : 'git.insertFailed';
  status.textContent = t(ok ? success : failure);
  status.setAttribute('role', ok ? 'status' : 'alert');
}

async function openFileSelection(
  state: GitPanelState,
  selection: Pick<GitFileSelection, 'path' | 'scope' | 'status' | 'originalPath'>,
  force = false,
): Promise<void> {
  const existing = getExistingFileSelection(state, selection);
  state.detailActive = true;
  if (!existing) state.scrollPositions.delete('inspector');

  if (existing && !existing.loading && existing.diff && !force) {
    renderPanel(state);
    return;
  }

  const pendingSelection = createLoadingFileSelection(selection, existing?.diff ?? null);
  state.selection = pendingSelection;
  renderPanel(state);

  const diff = await fetchDiffView(
    state.sessionId,
    state.repoRoot,
    selection.path,
    selection.scope,
  );
  const currentSelection = panelStates.get(getPanelKey(state.sessionId, state.repoRoot))?.selection;
  if (currentSelection !== pendingSelection) {
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
  state.detailActive = true;
  if (!existing) state.scrollPositions.delete('inspector');

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

  const details = await fetchCommitDetails(state.sessionId, state.repoRoot, hash);
  const currentSelection = panelStates.get(getPanelKey(state.sessionId, state.repoRoot))?.selection;
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
  const entries = await fetchGitLog(state.sessionId, state.repoRoot, nextCount);
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
