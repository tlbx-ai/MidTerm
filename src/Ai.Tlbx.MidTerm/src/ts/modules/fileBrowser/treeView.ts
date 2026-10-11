/**
 * File Browser Tree View
 *
 * Expandable tree component with lazy-loaded directory contents.
 */

import type { FileTreeEntry, FileTreeResponse } from './treeApi';
import { fetchTree } from './treeApi';
import { t } from '../i18n';
import { getFileIcon, formatSize } from '../fileViewer/rendering';

interface TreeState {
  rootPath: string;
  sessionId: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  treeData: Map<string, FileTreeEntry[]>;
  container: HTMLElement;
  selectionRequest: number;
  rootRequest: number;
  savedRoots: Map<string, { expanded: Set<string>; selected: string | null; scroll: number }>;
  onFileSelect: (entry: FileTreeEntry) => boolean | Promise<boolean>;
  onDirectoryOpen: ((entry: FileTreeEntry) => void) | undefined;
}

const treeStates = new Map<string, TreeState>();

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
    savedRoots: new Map(),
    onFileSelect,
    onDirectoryOpen,
  };
  treeStates.set(sessionId, state);
}

export async function setTreeRoot(sessionId: string, rootPath: string): Promise<void> {
  const state = treeStates.get(sessionId);
  if (!state) return;

  const request = ++state.rootRequest;
  const data = await fetchTree(rootPath, sessionId);
  if (request !== state.rootRequest) return;
  if (!data) {
    state.container.innerHTML = `<div class="tree-empty">${t('fileBrowser.unableToLoad')}</div>`;
    return;
  }

  applyTreeRoot(sessionId, rootPath, data);
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
  renderTree(state);
  state.container.scrollTop = saved?.scroll ?? 0;
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
  state.container.innerHTML = '';
  const entries = state.treeData.get(state.rootPath);
  if (!entries) return;

  const fragment = document.createDocumentFragment();
  for (const entry of sortEntries(entries)) {
    fragment.appendChild(createTreeNode(state, entry, 0));
  }
  state.container.appendChild(fragment);
}

function sortEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function createTreeNode(state: TreeState, entry: FileTreeEntry, depth: number): HTMLElement {
  const node = document.createElement('div');
  node.className = 'tree-node';
  if (state.selectedPath === entry.fullPath) node.classList.add('selected');

  const indent = document.createElement('span');
  indent.className = 'tree-indent';
  indent.style.width = `${depth * 16}px`;

  const expand = document.createElement('span');
  expand.className = 'tree-expand';
  if (entry.isDirectory) {
    const isExpanded = state.expandedPaths.has(entry.fullPath);
    expand.textContent = isExpanded ? '\u25BE' : '\u25B8';
    expand.classList.add('expandable');
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = getFileIcon(entry.name, entry.isDirectory);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;

  node.appendChild(indent);
  node.appendChild(expand);
  node.appendChild(icon);
  node.appendChild(name);

  if (entry.gitStatus) {
    const badge = document.createElement('span');
    badge.className = 'tree-git-badge';
    badge.textContent = entry.gitStatus;
    node.appendChild(badge);
  }

  if (!entry.isDirectory && entry.size != null) {
    const size = document.createElement('span');
    size.className = 'tree-size';
    size.textContent = formatSize(entry.size);
    node.appendChild(size);
  }

  node.addEventListener('click', () => {
    if (entry.isDirectory) {
      void toggleExpand(state, entry);
    } else {
      void selectFile(state, entry, node);
    }
  });
  if (entry.isDirectory)
    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      state.onDirectoryOpen?.(entry);
    });

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node-group';
  wrapper.appendChild(node);

  if (entry.isDirectory && state.expandedPaths.has(entry.fullPath)) {
    const children = state.treeData.get(entry.fullPath);
    if (children) {
      for (const child of sortEntries(children)) {
        wrapper.appendChild(createTreeNode(state, child, depth + 1));
      }
    }
  }

  return wrapper;
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
    if (!state.treeData.has(entry.fullPath)) {
      const data = await fetchTree(entry.fullPath, state.sessionId);
      if (data) {
        state.treeData.set(entry.fullPath, data.entries);
      }
    }
  }
  renderTree(state);
}
