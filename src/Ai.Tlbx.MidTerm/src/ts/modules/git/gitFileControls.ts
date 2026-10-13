import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import type { GitFileEntry, GitStatusResponse } from './types';
import { syncGitPanelDom } from './gitPanelDom';

export type GitFileScope = 'worktree' | 'staged';
export interface GitFileUi {
  layout: 'tree' | 'list';
  filter: string;
  collapsed: Set<string>;
  filterCollapsed: Set<string>;
  selected: Set<string>;
  anchor: string | null;
  focused: Map<string, string>;
  typed: string;
  typedAt: number;
}

const LAYOUT_KEY = 'tlbx-git-files-layout';
export const fileKey = (scope: string, path: string): string => `${scope}:${path}`;
export const folderKey = (section: string, path: string): string => `${section}:${path}`;
export function createGitFileUi(): GitFileUi {
  let layout: GitFileUi['layout'] = 'tree';
  try {
    if (localStorage.getItem(LAYOUT_KEY) === 'list') layout = 'list';
  } catch {
    /* Keep the preference in memory. */
  }
  return {
    layout,
    filter: '',
    collapsed: new Set(),
    filterCollapsed: new Set(),
    selected: new Set(),
    anchor: null,
    focused: new Map(),
    typed: '',
    typedAt: 0,
  };
}

export function collapsedGitFolders(ui: GitFileUi): Set<string> {
  return ui.filter.trim() ? ui.filterCollapsed : ui.collapsed;
}

export function filteredGitFiles(files: GitFileEntry[], ui: GitFileUi): GitFileEntry[] {
  const filter = ui.filter.trim().toLocaleLowerCase();
  if (!filter) return files;
  return files.filter(
    (file) =>
      file.path.toLocaleLowerCase().includes(filter) ||
      file.originalPath?.toLocaleLowerCase().includes(filter),
  );
}

export function selectedGitPaths(ui: GitFileUi, scope: GitFileScope): string[] {
  const prefix = `${scope}:`;
  return [...ui.selected]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export function pruneGitFileSelection(ui: GitFileUi, status: GitStatusResponse): void {
  const keys = new Set([
    ...filteredGitFiles(status.staged, ui).map((file) => fileKey('staged', file.path)),
    ...filteredGitFiles([...status.modified, ...status.untracked, ...status.conflicted], ui).map(
      (file) => fileKey('worktree', file.path),
    ),
  ]);
  for (const key of ui.selected) if (!keys.has(key)) ui.selected.delete(key);
  if (ui.anchor && !keys.has(ui.anchor)) ui.anchor = null;
}

export function renderGitFileControls(ui: GitFileUi, busy: boolean): string {
  return `<div class="git-file-controls">
    <input type="search" class="git-file-filter" data-git-file-filter="true" aria-label="${t('git.filterFiles')}" placeholder="${t('git.filterFiles')}" value="${escapeHtml(ui.filter)}">
    <button class="git-action-button" data-action="toggle-file-layout" title="${t(ui.layout === 'tree' ? 'git.listView' : 'git.treeView')}" type="button">${t(ui.layout === 'tree' ? 'git.listView' : 'git.treeView')}</button>
  </div><div class="git-file-selection-actions">${renderSelectedActions(ui, busy)}</div>`;
}

function renderSelectedActions(ui: GitFileUi, busy: boolean): string {
  const staged = selectedGitPaths(ui, 'staged').length,
    working = selectedGitPaths(ui, 'worktree').length;
  const disabled = busy ? ' disabled' : '';
  if (!staged && !working) return '';
  return `${working ? `<button class="git-action-button" data-action="stage-selected-files"${disabled} type="button">${t('git.stageSelectedFiles')} (${working})</button>` : ''}
    ${staged ? `<button class="git-action-button" data-action="unstage-selected-files"${disabled} type="button">${t('git.unstageSelectedFiles')} (${staged})</button>` : ''}`;
}

export function patchGitFileSelection(ui: GitFileUi, container: HTMLElement, busy = false): void {
  for (const row of container.querySelectorAll<HTMLElement>('.git-tree-file[data-file-key]')) {
    const selected = ui.selected.has(row.dataset.fileKey ?? '');
    row.classList.toggle('git-file-multi-selected', selected);
    row.setAttribute('aria-selected', String(selected));
  }
  const actions = container.querySelector<HTMLElement>('.git-file-selection-actions');
  if (actions) syncGitPanelDom(actions, renderSelectedActions(ui, busy));
}

export function chooseGitFile(
  ui: GitFileUi,
  row: HTMLElement,
  container: HTMLElement,
  extend: boolean,
  toggle: boolean,
): void {
  const key = row.dataset.fileKey;
  if (!key) return;
  if (extend && ui.anchor) {
    const keys = [...container.querySelectorAll<HTMLElement>('.git-tree-file[data-file-key]')].map(
      (file) => file.dataset.fileKey,
    );
    const start = keys.indexOf(ui.anchor),
      end = keys.indexOf(key);
    if (start >= 0 && end >= 0) {
      if (!toggle) ui.selected.clear();
      for (const selected of keys.slice(Math.min(start, end), Math.max(start, end) + 1))
        if (selected) ui.selected.add(selected);
    } else {
      if (!toggle) ui.selected.clear();
      ui.selected.add(key);
      ui.anchor = key;
    }
  } else {
    const previous = ui.selected.has(key);
    if (!toggle) ui.selected.clear();
    if (toggle && previous) ui.selected.delete(key);
    else ui.selected.add(key);
    ui.anchor = key;
  }
  rememberGitFileFocus(ui, row);
  patchGitFileSelection(ui, container);
}

export function rememberGitFileFocus(ui: GitFileUi, row: HTMLElement): void {
  const section = row.closest<HTMLElement>('.git-section')?.dataset.section;
  const key = row.dataset.gitNode;
  if (!section || !key) return;
  ui.focused.set(section, key);
  for (const node of row
    .closest('.git-section-body')
    ?.querySelectorAll<HTMLElement>('[data-git-node]') ?? [])
    node.tabIndex = node === row ? 0 : -1;
}

export function toggleGitFileLayout(ui: GitFileUi): void {
  ui.layout = ui.layout === 'tree' ? 'list' : 'tree';
  try {
    localStorage.setItem(LAYOUT_KEY, ui.layout);
  } catch {
    /* Keep the preference in memory. */
  }
}

export function toggleGitFolder(
  ui: GitFileUi,
  row: HTMLElement,
  container: HTMLElement,
  render: () => void,
): void {
  const { section, folder } = row.dataset;
  if (!section || !folder) return;
  const key = folderKey(section, folder),
    collapsed = collapsedGitFolders(ui);
  rememberGitFileFocus(ui, row);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  render();
  container
    .querySelector<HTMLElement>(`[data-git-node="${CSS.escape(key)}"]`)
    ?.focus({ preventScroll: true });
}

export function handleGitFileControl(
  ui: GitFileUi,
  element: HTMLElement,
  event: MouseEvent,
  container: HTMLElement,
  render: () => void,
  busy: boolean,
): boolean {
  const action = element.dataset.action;
  if (action === 'open-file') {
    if (!busy)
      chooseGitFile(ui, element, container, event.shiftKey, event.ctrlKey || event.metaKey);
    return event.shiftKey || event.ctrlKey || event.metaKey;
  }
  if (action === 'toggle-git-folder') {
    toggleGitFolder(ui, element, container, render);
    return true;
  }
  if (action === 'toggle-file-layout') {
    toggleGitFileLayout(ui);
    render();
    container
      .querySelector<HTMLElement>('[data-action="toggle-file-layout"]')
      ?.focus({ preventScroll: true });
    return true;
  }
  return false;
}
