import {
  chooseGitFile,
  rememberGitFileFocus,
  patchGitFileSelection,
  type GitFileUi,
} from './gitFileControls';

type FolderToggle = (row: HTMLElement) => void;
function focus(ui: GitFileUi, row: HTMLElement | undefined): void {
  if (!row) return;
  rememberGitFileFocus(ui, row);
  row.focus();
}

function treeDirection(
  ui: GitFileUi,
  row: HTMLElement,
  event: KeyboardEvent,
  toggle: FolderToggle,
): boolean {
  if (event.key === 'ArrowRight') {
    if (row.dataset.action !== 'toggle-git-folder') return true;
    if (row.getAttribute('aria-expanded') === 'false') toggle(row);
    else {
      const group = row.getAttribute('aria-controls');
      if (group)
        focus(
          ui,
          document.getElementById(group)?.querySelector<HTMLElement>('[data-git-node]') ??
            undefined,
        );
    }
    return true;
  }
  if (event.key === 'ArrowLeft') {
    if (row.getAttribute('aria-expanded') === 'true') toggle(row);
    else
      focus(
        ui,
        row.closest('[role="group"]')?.parentElement?.querySelector<HTMLElement>('.git-tree-dir') ??
          undefined,
      );
    return true;
  }
  return false;
}

function move(
  ui: GitFileUi,
  row: HTMLElement,
  container: HTMLElement,
  event: KeyboardEvent,
): boolean {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
  const nodes = [
    ...(row.closest('.git-section-body')?.querySelectorAll<HTMLElement>('[data-git-node]') ?? []),
  ];
  const index = nodes.indexOf(row);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? nodes.length - 1
        : Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
  const target = nodes[next];
  focus(ui, target);
  if (target?.dataset.fileKey && event.shiftKey)
    chooseGitFile(ui, target, container, true, event.ctrlKey || event.metaKey);
  return true;
}

function select(
  ui: GitFileUi,
  row: HTMLElement,
  container: HTMLElement,
  event: KeyboardEvent,
): boolean {
  if (event.key === ' ' && row.dataset.fileKey) {
    chooseGitFile(ui, row, container, event.shiftKey, true);
    return true;
  }
  if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) {
    const files = [
      ...(row.closest('.git-section-body')?.querySelectorAll<HTMLElement>('.git-tree-file') ?? []),
    ];
    ui.selected.clear();
    for (const file of files) if (file.dataset.fileKey) ui.selected.add(file.dataset.fileKey);
    ui.anchor = row.dataset.fileKey ?? null;
    patchGitFileSelection(ui, container);
    return true;
  }
  if (event.key === 'Enter') {
    row.click();
    return true;
  }
  return false;
}

function typeAhead(ui: GitFileUi, row: HTMLElement, event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === ' ')
    return false;
  const now = performance.now();
  ui.typed = now - ui.typedAt < 600 ? ui.typed + event.key : event.key;
  ui.typedAt = now;
  const nodes = [
    ...(row.closest('.git-section-body')?.querySelectorAll<HTMLElement>('[data-git-node]') ?? []),
  ];
  const index = nodes.indexOf(row);
  const ordered = [...nodes.slice(index + 1), ...nodes.slice(0, index + 1)];
  const target = ordered.find((node) =>
    node.dataset.sortName?.toLocaleLowerCase().startsWith(ui.typed.toLocaleLowerCase()),
  );
  focus(ui, target);
  return true;
}

export function handleGitFileKey(
  ui: GitFileUi,
  event: KeyboardEvent,
  container: HTMLElement,
  toggle: FolderToggle,
): void {
  if (!(event.target instanceof Element)) return;
  const row = event.target.closest<HTMLElement>('[data-git-node]');
  if (!row) return;
  if (
    treeDirection(ui, row, event, toggle) ||
    move(ui, row, container, event) ||
    select(ui, row, container, event) ||
    typeAhead(ui, row, event)
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
}
