import type { GitFileEntry } from './types';
import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import { fileStatusPresentation } from './fileStatus';
import { repositoryFilePath } from '../fileViewer/pathDetails';
import { gitFileAction } from './gitOperations';

type FileScope = 'worktree' | 'staged';
type TreeSelection = { kind: 'file'; path: string; scope: FileScope } | { kind: 'commit' } | null;

export function renderGitFileTree(
  files: GitFileEntry[],
  scope: FileScope,
  selection: TreeSelection,
  repoRoot: string,
  busy: boolean,
): string {
  return renderTreeNode(buildFileTree(files, scope), 0, selection, repoRoot, busy);
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: GitFileEntry | null;
  scope: FileScope;
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
  selection: TreeSelection,
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

function renderEntryStatistics(file: GitFileEntry): string {
  if (file.status === 'untracked') return `<span class="git-file-loc">${t('git.newFile')}</span>`;
  return `<span class="git-file-loc"><span class="git-loc-add">+${file.additions}</span> <span class="git-loc-del">-${file.deletions}</span></span>`;
}
