/**
 * File Browser Tree View
 *
 * Expandable tree component with lazy-loaded directory contents.
 */

import type { FileTreeEntry, FileTreeResponse } from './treeApi';
import { fetchTree } from './treeApi';
import { t } from '../i18n';
import { getFileVisibility } from '../fileViewer/visibility';
import { getFileIcon, formatSize } from '../fileViewer/rendering';
import { reconcileKeyedChildren } from '../../utils/domReconcile';

interface TreeState {
  rootPath: string;
  sessionId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  treeData: Map<string, FileTreeEntry[]>;
  container: HTMLElement;
  selectionRequest: number;
  rootRequest: number;
  excludedCount: number;
  savedRoots: Map<string, { expanded: Set<string>; selected: string | null; scroll: number }>;
  onFileSelect: (entry: FileTreeEntry) => boolean | Promise<boolean>;
  onDirectoryOpen: ((entry: FileTreeEntry) => void) | undefined;
}

const treeStates = new Map<string, TreeState>();
const rowEntries = new WeakMap<HTMLElement, FileTreeEntry>();

export function getTreeSelection(sessionId: string): FileTreeEntry | null {
  const state = treeStates.get(sessionId);
  if (!state?.selectedPath) return null;
  for (const entries of state.treeData.values()) {
    const selected = entries.find((entry) => entry.fullPath === state.selectedPath);
    if (selected) return selected;
  }
  return null;
}

export function setTreeSelection(sessionId: string, path: string): void {
  const state = treeStates.get(sessionId);
  if (!state) return;
  state.selectedPath = path;
  renderTree(state);
}

export function createTreeView(
  container: HTMLElement,
  sessionId: string,
  onFileSelect: TreeState['onFileSelect'],
  onDirectoryOpen?: TreeState['onDirectoryOpen'],
): void {
  const state: TreeState = {
    rootPath: '',
    sessionId,
    expandedPaths: new Set(),
    selectedPath: null,
    treeData: new Map(),
    container,
    selectionRequest: 0,
    rootRequest: 0,
    excludedCount: 0,
    savedRoots: new Map(),
    onFileSelect,
    onDirectoryOpen,
  };
  treeStates.set(sessionId, state);
}

/** Apply a validated directory only after both navigation and listing have succeeded. */
export function applyTreeRoot(sessionId: string, rootPath: string, data: FileTreeResponse): void {
  const state = treeStates.get(sessionId);
  if (!state) return;
  state.rootRequest++;
  state.selectionRequest++;
  if (state.rootPath)
    state.savedRoots.set(state.rootPath, {
      expanded: new Set(state.expandedPaths),
      selected: state.selectedPath,
      scroll: state.container.scrollTop,
    });
  const saved = state.savedRoots.get(rootPath);
  state.rootPath = rootPath;
  state.expandedPaths = new Set(saved?.expanded ?? []);
  state.selectedPath = saved?.selected ?? null;
  state.treeData.set(rootPath, data.entries);
  state.excludedCount = data.visibility.excludedCount;
  renderTree(state);
  state.container.scrollTop = saved?.scroll ?? 0;
}

export async function applyTreeVisibility(
  sessionId: string,
  rootPath: string,
  data: FileTreeResponse,
  signal?: AbortSignal,
): Promise<void> {
  const state = treeStates.get(sessionId);
  if (!state || state.rootPath !== rootPath) return;
  const request = ++state.rootRequest;
  const scroll = state.container.scrollTop;
  const preferences = getFileVisibility();
  const loaded = new Map<string, FileTreeEntry[]>([[rootPath, data.entries]]);
  const expanded = [...state.expandedPaths];
  for (let index = 0; index < expanded.length; index += 4) {
    const pages = await Promise.all(
      expanded
        .slice(index, index + 4)
        .map(async (path) => ({ path, data: await fetchTree(path, sessionId, signal) })),
    );
    if (
      state.rootRequest !== request ||
      signal?.aborted ||
      state.rootPath !== rootPath ||
      getFileVisibility() !== preferences
    )
      return;
    for (const page of pages) if (page.data) loaded.set(page.path, page.data.entries);
  }
  state.treeData = loaded;
  state.excludedCount = data.visibility.excludedCount;
  renderTree(state);
  state.container.scrollTop = scroll;
}

export function destroyTreeView(sessionId: string): void {
  const state = treeStates.get(sessionId);
  if (state) {
    state.selectionRequest++;
    state.rootRequest++;
  }
  treeStates.delete(sessionId);
}

function renderTree(state: TreeState): void {
  const focused = document.activeElement as HTMLElement | null;
  const hadFocus = !!focused && state.container.contains(focused);
  const entries = state.treeData.get(state.rootPath);
  if (!entries) return;
  if (entries.length === 0) {
    state.container.innerHTML = `<div class="tree-empty" role="status">${t(state.excludedCount ? 'fileBrowser.allFiltered' : 'fileViewer.emptyDirectory')}</div>`;
    return;
  }

  renderBranch(state.container, state, entries, 0);
  if (hadFocus && !focused.isConnected) {
    state.container.tabIndex = -1;
    state.container.focus({ preventScroll: true });
  }
}

function renderBranch(
  container: HTMLElement,
  state: TreeState,
  entries: FileTreeEntry[],
  depth: number,
): void {
  reconcileKeyedChildren(container, sortEntries(entries), {
    key: (entry) => entry.fullPath,
    create: () => createTreeNode(state),
    patch: (wrapper, entry) => {
      patchTreeNode(wrapper, state, entry, depth);
    },
  });
}

function sortEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function createTreeNode(state: TreeState): HTMLElement {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.tabIndex = -1;
  for (const className of [
    'tree-indent',
    'tree-expand',
    'tree-icon',
    'tree-name',
    'file-visibility-badge',
    'tree-git-badge',
    'tree-size',
  ]) {
    const span = document.createElement('span');
    span.className = className;
    node.appendChild(span);
  }
  node.addEventListener('click', () => {
    const entry = rowEntries.get(node);
    if (!entry) return;
    if (entry.isDirectory) {
      void toggleExpand(state, entry);
    } else {
      void selectFile(state, entry, node);
    }
  });
  node.addEventListener('dblclick', (event) => {
    const entry = rowEntries.get(node);
    if (!entry?.isDirectory) return;
    event.preventDefault();
    state.onDirectoryOpen?.(entry);
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node-group';
  wrapper.appendChild(node);
  const children = document.createElement('div');
  children.className = 'tree-children';
  wrapper.appendChild(children);
  return wrapper;
}

function patchTreeNode(
  wrapper: HTMLElement,
  state: TreeState,
  entry: FileTreeEntry,
  depth: number,
): void {
  const node = wrapper.firstElementChild as HTMLElement;
  rowEntries.set(node, entry);
  node.dataset.path = entry.fullPath;
  node.classList.toggle('selected', state.selectedPath === entry.fullPath);
  const text = (selector: string, value: string): void => {
    const element = node.querySelector<HTMLElement>(selector);
    if (element && element.textContent !== value) element.textContent = value;
  };
  const indent = node.querySelector<HTMLElement>('.tree-indent');
  if (indent) indent.style.width = `${depth * 16}px`;
  const expanded = entry.isDirectory && state.expandedPaths.has(entry.fullPath);
  text('.tree-expand', entry.isDirectory ? (expanded ? '▾' : '▸') : '');
  text('.tree-icon', getFileIcon(entry.name, entry.isDirectory));
  text('.tree-name', entry.name);
  text(
    '.file-visibility-badge',
    [entry.isHidden ? t('fileBrowser.hidden') : '', entry.isIgnored ? t('fileBrowser.ignored') : '']
      .filter(Boolean)
      .join(', '),
  );
  text('.tree-git-badge', entry.gitStatus ?? '');
  text('.tree-size', !entry.isDirectory && entry.size != null ? formatSize(entry.size) : '');
  for (const selector of ['.file-visibility-badge', '.tree-git-badge', '.tree-size']) {
    hideEmptyMetadata(node, selector);
  }
  node.querySelector('.tree-expand')?.classList.toggle('expandable', entry.isDirectory);
  const children = wrapper.lastElementChild as HTMLElement;
  children.hidden = !expanded;
  if (expanded) renderBranch(children, state, state.treeData.get(entry.fullPath) ?? [], depth + 1);
}

function hideEmptyMetadata(node: HTMLElement, selector: string): void {
  const span = node.querySelector<HTMLElement>(selector);
  if (span) span.style.display = span.textContent ? '' : 'none';
}

async function selectFile(
  state: TreeState,
  entry: FileTreeEntry,
  node: HTMLElement,
): Promise<void> {
  const request = ++state.selectionRequest;
  const accepted = await state.onFileSelect(entry);
  if (!accepted || request !== state.selectionRequest) return;
  state.selectedPath = entry.fullPath;
  state.container.querySelectorAll('.tree-node.selected').forEach((selected) => {
    selected.classList.remove('selected');
  });
  node.classList.add('selected');
}

async function toggleExpand(state: TreeState, entry: FileTreeEntry): Promise<void> {
  if (state.expandedPaths.has(entry.fullPath)) {
    state.expandedPaths.delete(entry.fullPath);
  } else {
    state.expandedPaths.add(entry.fullPath);
    const request = state.rootRequest;
    const data = await fetchTree(entry.fullPath, state.sessionId);
    if (request !== state.rootRequest || !state.expandedPaths.has(entry.fullPath)) return;
    if (data) {
      state.treeData.set(entry.fullPath, data.entries);
    }
  }
  renderTree(state);
}
