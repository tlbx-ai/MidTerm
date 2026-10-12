import { t } from '../i18n';

export interface GitDiffUi {
  sideBySide: boolean;
  selected: Set<string>;
  anchor: string | null;
  activeHunk: number;
}

const MODE_KEY = 'tlbx-git-diff-side-by-side';
export function createGitDiffUi(): GitDiffUi {
  let sideBySide = false;
  try {
    sideBySide = localStorage.getItem(MODE_KEY) === 'true';
  } catch {
    /* Keep the current choice in memory. */
  }
  return { sideBySide, selected: new Set(), anchor: null, activeHunk: -1 };
}

export function clearDiffSelection(ui: GitDiffUi): void {
  ui.selected.clear();
  ui.anchor = null;
  ui.activeHunk = -1;
}

export function renderDiffControls(
  ui: GitDiffUi,
  canSelect: boolean,
  staged: boolean,
  hasHunks: boolean,
  busy = false,
): string {
  if (!hasHunks) return '';
  return `<button class="git-diff-wrap" data-action="toggle-diff-side" aria-pressed="${ui.sideBySide}" type="button">${t('git.sideBySide')}</button>
    <button class="git-diff-wrap" data-action="previous-diff-hunk" title="${t('git.previousChange')}" aria-label="${t('git.previousChange')}" type="button">↑</button>
    <button class="git-diff-wrap" data-action="next-diff-hunk" title="${t('git.nextChange')}" aria-label="${t('git.nextChange')}" type="button">↓</button>
    ${canSelect ? `<button class="git-action-button git-diff-selection-action" data-action="apply-diff-selection"${ui.selected.size ? '' : ' hidden'}${busy ? ' disabled' : ''} type="button">${t(staged ? 'git.unstageSelectedLines' : 'git.stageSelectedLines')}</button>` : ''}`;
}

function patchSelection(ui: GitDiffUi, container: HTMLElement): void {
  const lines = container.querySelectorAll<HTMLElement>('[data-diff-line]');
  for (const line of lines) {
    const selected = ui.selected.has(line.dataset.diffLine ?? '');
    line.classList.toggle('git-diff-line-selected', selected);
    line.setAttribute('aria-selected', String(selected));
  }
  const action = container.querySelector<HTMLElement>('.git-diff-selection-action');
  if (action) action.hidden = ui.selected.size === 0;
}

function chooseLine(
  ui: GitDiffUi,
  line: HTMLElement,
  container: HTMLElement,
  extend: boolean,
  toggle: boolean,
): void {
  const id = line.dataset.diffLine;
  if (!id) return;
  if (extend && ui.anchor) {
    const ordered = [...container.querySelectorAll<HTMLElement>('[data-diff-line]')].map(
      (node) => node.dataset.diffLine,
    );
    const start = ordered.indexOf(ui.anchor),
      end = ordered.indexOf(id);
    if (start >= 0 && end >= 0) {
      if (!toggle) ui.selected.clear();
      for (const selected of ordered.slice(Math.min(start, end), Math.max(start, end) + 1))
        if (selected) ui.selected.add(selected);
    }
  } else {
    const wasSelected = ui.selected.has(id);
    if (!toggle) ui.selected.clear();
    if (toggle && wasSelected) ui.selected.delete(id);
    else ui.selected.add(id);
    ui.anchor = id;
  }
  for (const node of container.querySelectorAll<HTMLElement>('[data-diff-line]'))
    node.tabIndex = node === line ? 0 : -1;
  patchSelection(ui, container);
}

export function handleDiffControl(
  ui: GitDiffUi,
  element: HTMLElement,
  event: MouseEvent,
  container: HTMLElement,
  render: () => void,
): boolean {
  const action = element.dataset.action;
  if (action === 'select-diff-line') {
    clickLine(ui, element, event, container);
    return true;
  }
  if (action === 'toggle-diff-side') {
    ui.sideBySide = !ui.sideBySide;
    try {
      localStorage.setItem(MODE_KEY, String(ui.sideBySide));
    } catch {
      /* Keep the current choice in memory. */
    }
    render();
    container
      .querySelector<HTMLElement>('[data-action="toggle-diff-side"]')
      ?.focus({ preventScroll: true });
    return true;
  }
  if (action === 'next-diff-hunk' || action === 'previous-diff-hunk') {
    navigateHunk(ui, container, action === 'next-diff-hunk' ? 1 : -1);
    return true;
  }
  return false;
}

function clickLine(
  ui: GitDiffUi,
  element: HTMLElement,
  event: MouseEvent,
  container: HTMLElement,
): void {
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    document.getSelection()?.isCollapsed === false
  )
    return;
  chooseLine(ui, element, container, event.shiftKey, event.ctrlKey || event.metaKey);
  element.focus({ preventScroll: true });
}

function navigateHunk(ui: GitDiffUi, container: HTMLElement, direction: number): void {
  const hunks = [...container.querySelectorAll<HTMLElement>('.git-diff-hunk-block')];
  if (!hunks.length) return;
  const origin = ui.activeHunk < 0 ? (direction > 0 ? -1 : 0) : ui.activeHunk;
  ui.activeHunk = (origin + direction + hunks.length) % hunks.length;
  const hunk = hunks[ui.activeHunk];
  hunk?.scrollIntoView({ block: 'start' });
  hunk?.querySelector<HTMLElement>('.git-diff-lines')?.focus({ preventScroll: true });
}

export function handleDiffKey(ui: GitDiffUi, event: KeyboardEvent, container: HTMLElement): void {
  if (!(event.target instanceof Element)) return;
  const line = event.target.closest<HTMLElement>('[data-diff-line]');
  if (!line) return;
  const handled = selectionKey(ui, event, container, line) || moveFocus(ui, event, container, line);
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function selectionKey(
  ui: GitDiffUi,
  event: KeyboardEvent,
  container: HTMLElement,
  line: HTMLElement,
): boolean {
  let handled = true;
  if (event.key === 'Escape' && ui.selected.size) {
    clearDiffSelection(ui);
    patchSelection(ui, container);
  } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
    for (const node of container.querySelectorAll<HTMLElement>('[data-diff-line]'))
      if (node.dataset.diffLine) ui.selected.add(node.dataset.diffLine);
    patchSelection(ui, container);
  } else if (event.key === ' ' || event.key === 'Enter')
    chooseLine(ui, line, container, event.shiftKey, true);
  else handled = false;
  return handled;
}

function moveFocus(
  ui: GitDiffUi,
  event: KeyboardEvent,
  container: HTMLElement,
  line: HTMLElement,
): boolean {
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const lines = [...container.querySelectorAll<HTMLElement>('[data-diff-line]')];
    const index = lines.indexOf(line);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? lines.length - 1
          : Math.max(0, Math.min(lines.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    const target = lines[next];
    if (target) {
      for (const node of lines) node.tabIndex = node === target ? 0 : -1;
      target.focus();
      if (event.shiftKey) chooseLine(ui, target, container, true, event.ctrlKey || event.metaKey);
    }
    return true;
  }
  return false;
}
