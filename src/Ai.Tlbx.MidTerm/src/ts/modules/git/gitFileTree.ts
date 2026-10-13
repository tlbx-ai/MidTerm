import type { GitFileEntry } from './types';
import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import { fileStatusPresentation } from './fileStatus';
import { repositoryFilePath } from '../fileViewer/pathDetails';
import { gitFileAction } from './gitOperations';
import {
  fileKey,
  folderKey,
  filteredGitFiles,
  collapsedGitFolders,
  type GitFileUi,
  type GitFileScope,
} from './gitFileControls';

type TreeSelection =
  { kind: 'file'; path: string; scope: GitFileScope } | { kind: 'commit' } | null;
interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: GitFileEntry | null;
}
export interface GitFileTreeContext {
  scope: GitFileScope;
  section: string;
  selection: TreeSelection;
  root: string;
  busy: boolean;
  ui: GitFileUi;
}
interface RenderingContext extends GitFileTreeContext {
  tabStop: string;
}

export function renderGitFileTree(files: GitFileEntry[], context: GitFileTreeContext): string {
  const visible = filteredGitFiles(files, context.ui);
  if (!visible.length)
    return `<p class="git-panel-hint git-file-filter-empty">${t('git.noMatchingFiles')}</p>`;
  const tree = buildFileTree(visible),
    first = sortedChildren(tree)[0];
  const stored = context.ui.focused.get(context.section);
  const valid =
    stored && [...walkNodes(tree, context)].some((node) => nodeKey(node, context) === stored);
  const tabStop = valid ? stored : first ? nodeKey(first, context) : '';
  const view: RenderingContext = { ...context, tabStop };
  if (context.ui.layout === 'list') {
    const listed = [...visible].sort((a, b) => a.path.localeCompare(b.path));
    view.tabStop =
      stored && listed.some((file) => fileKey(context.scope, file.path) === stored)
        ? stored
        : fileKey(context.scope, listed[0]?.path ?? '');
    return listed
      .map((file, index) => renderFile(file, file.path, 0, index + 1, listed.length, view))
      .join('');
  }
  return renderTreeNode(tree, 0, view);
}

function buildFileTree(files: GitFileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), file: null };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index];
      if (name === undefined) continue;
      let child = node.children.get(name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, index + 1).join('/'),
          children: new Map(),
          file: null,
        };
        node.children.set(name, child);
      }
      node = child;
    }
    const name = parts[parts.length - 1];
    if (name !== undefined)
      node.children.set(name, { name, path: file.path, children: new Map(), file });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (Boolean(a.file) !== Boolean(b.file)) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function* walkNodes(node: TreeNode, view: GitFileTreeContext): Generator<TreeNode> {
  for (const child of node.children.values()) {
    yield child;
    if (!collapsedGitFolders(view.ui).has(nodeKey(child, view))) yield* walkNodes(child, view);
  }
}
function nodeKey(node: TreeNode, view: GitFileTreeContext): string {
  return node.file ? fileKey(view.scope, node.path) : folderKey(view.section, node.path);
}
function renderTreeNode(node: TreeNode, depth: number, view: RenderingContext): string {
  const children = sortedChildren(node);
  return children
    .map((child, index) =>
      child.file
        ? renderFile(child.file, child.name, depth, index + 1, children.length, view)
        : renderFolder(child, depth, index + 1, children.length, view),
    )
    .join('');
}

function renderFolder(
  node: TreeNode,
  depth: number,
  position: number,
  size: number,
  view: RenderingContext,
): string {
  const key = nodeKey(node, view),
    expanded = !collapsedGitFolders(view.ui).has(key);
  const group = 'git-folder-' + encodeURIComponent(`${view.root}:${key}`);
  return `<div class="git-tree-directory" data-path="${escapeHtml(node.path)}" data-scope="${view.scope}">
    <button class="git-tree-dir" data-action="toggle-git-folder" data-folder="${escapeHtml(node.path)}" data-section="${view.section}" data-git-node="${escapeHtml(key)}" data-sort-name="${escapeHtml(node.name)}" data-depth="${depth}" role="treeitem" aria-level="${depth + 1}" aria-posinset="${position}" aria-setsize="${size}" aria-expanded="${expanded}"${expanded ? ` aria-owns="${group}"` : ''} aria-controls="${group}" tabindex="${view.tabStop === key ? 0 : -1}" style="padding-left:${12 + depth * 16}px" type="button"><span aria-hidden="true">${expanded ? '▾' : '▸'}</span><span class="git-tree-dir-name">${escapeHtml(node.name)}/</span></button>
    ${expanded ? `<div role="group" id="${group}">${renderTreeNode(node, depth + 1, view)}</div>` : ''}
  </div>`;
}

function renderFile(
  file: GitFileEntry,
  label: string,
  depth: number,
  position: number,
  size: number,
  view: RenderingContext,
): string {
  const presentation = fileStatusPresentation(file.status),
    key = fileKey(view.scope, file.path);
  const statusId = `git-file-status-${encodeURIComponent(`${view.root}:${view.scope}:${file.path}`)}`;
  const inspected =
    view.selection?.kind === 'file' &&
    view.selection.path === file.path &&
    view.selection.scope === view.scope;
  const selected = view.ui.selected.has(key),
    fullPath = escapeHtml(repositoryFilePath(view.root, file.path));
  const role = view.ui.layout === 'tree' ? 'treeitem' : 'option';
  return `<div class="git-tree-file-row" data-path="${escapeHtml(file.path)}" data-scope="${view.scope}"><button class="git-tree-file${inspected ? ' git-tree-file-selected' : ''}${selected ? ' git-file-multi-selected' : ''}" title="${fullPath}" aria-label="${fullPath}"${presentation ? ` aria-describedby="${escapeHtml(statusId)}"` : ''} role="${role}" aria-selected="${selected}" aria-posinset="${position}" aria-setsize="${size}"${role === 'treeitem' ? ` aria-level="${depth + 1}"` : ''} data-action="open-file" data-path="${escapeHtml(file.path)}" data-status="${escapeHtml(file.status)}" data-scope="${view.scope}" data-file-key="${escapeHtml(key)}" data-git-node="${escapeHtml(key)}" data-sort-name="${escapeHtml(file.path.slice(file.path.lastIndexOf('/') + 1))}" data-depth="${depth}" tabindex="${view.tabStop === key ? 0 : -1}"${file.originalPath ? ` data-original-path="${escapeHtml(file.originalPath)}"` : ''} style="padding-left:${12 + depth * 16}px" type="button">
    <span class="git-tree-name">${escapeHtml(label)}</span>${renderEntryStatistics(file)}
    ${presentation ? `<span class="git-file-indicator" id="${escapeHtml(statusId)}" data-git-status="${presentation.status}" role="img" title="${escapeHtml(presentation.label)}" aria-label="${escapeHtml(presentation.label)}">${presentation.letter}</span>` : ''}
  </button>${view.section === 'conflicts' ? `<button class="git-action-button git-file-action" data-action="resolve-conflict" data-path="${escapeHtml(file.path)}"${view.busy ? ' disabled' : ''} type="button">${t('git.resolveConflict')}</button>` : gitFileAction(file.path, view.scope === 'staged', view.busy)}</div>`;
}

function renderEntryStatistics(file: GitFileEntry): string {
  if (file.status === 'untracked') return `<span class="git-file-loc">${t('git.newFile')}</span>`;
  return `<span class="git-file-loc"><span class="git-loc-add">+${file.additions}</span> <span class="git-loc-del">-${file.deletions}</span></span>`;
}
