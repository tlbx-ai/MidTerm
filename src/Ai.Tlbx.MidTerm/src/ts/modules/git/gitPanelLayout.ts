export interface GitPanelLayoutState {
  detailActive: boolean;
  selection: { kind: 'file' | 'commit'; path?: string; scope?: string; hash?: string } | null;
  scrollPositions: Map<string, { top: number; left: number }>;
}

interface LayoutController {
  update: () => void;
  dispose: () => void;
}

const controllers = new WeakMap<HTMLElement, LayoutController>();

function selectedRow(container: HTMLElement, state: GitPanelLayoutState): HTMLElement | undefined {
  const selection = state.selection;
  return Array.from(container.querySelectorAll<HTMLElement>('[data-action]')).find((row) =>
    selection?.kind === 'file'
      ? row.dataset.action === 'open-file' &&
        row.dataset.path === selection.path &&
        row.dataset.scope === selection.scope
      : selection?.kind === 'commit' &&
        row.dataset.action === 'open-commit' &&
        row.dataset.hash === selection.hash,
  );
}

function scrollKey(element: HTMLElement): string | null {
  if (element.classList.contains('git-inspector-body')) return 'inspector';
  if (element.classList.contains('git-panel-sections')) return 'sections';
  if (element.classList.contains('git-commits-list')) return 'history';
  if (element.classList.contains('git-section-body'))
    return `section:${element.parentElement?.querySelector<HTMLElement>('[data-section]')?.dataset.section}`;
  return null;
}

function restoreScroll(container: HTMLElement, state: GitPanelLayoutState): void {
  for (const scroller of container.querySelectorAll<HTMLElement>(
    '.git-panel-sections, .git-section-body, .git-commits-list, .git-inspector-body',
  )) {
    const key = scrollKey(scroller);
    const position = key ? state.scrollPositions.get(key) : undefined;
    if (position && scroller.clientHeight > 0) {
      scroller.scrollTop = position.top;
      scroller.scrollLeft = position.left;
    }
  }
}

function repairFocus(
  container: HTMLElement,
  state: GitPanelLayoutState,
  compact: boolean,
  lastFocus: HTMLElement | null,
): void {
  const active = document.activeElement;
  const mayRepair =
    active === document.body || (active instanceof HTMLElement && container.contains(active));
  if (!mayRepair || !lastFocus?.isConnected || !container.contains(lastFocus)) return;
  if (active !== document.body && (active as HTMLElement).getClientRects().length) return;
  const target =
    compact && state.detailActive && state.selection
      ? container.querySelector<HTMLElement>('.git-inspector-back')
      : (selectedRow(container, state) ??
        container.querySelector<HTMLElement>('.git-panel-list button'));
  if (target?.getClientRects().length) target.focus({ preventScroll: true });
}

/** The CSS container decides the mode; this only preserves navigation, focus and scroll. */
export function connectGitPanelLayout(
  container: HTMLElement,
  current: () => GitPanelLayoutState | undefined,
): LayoutController | undefined {
  const existing = controllers.get(container);
  if (existing) return existing;
  if (!container.querySelector('.git-panel-shell')) return undefined;
  const events = new AbortController();
  let lastFocus: HTMLElement | null = null;
  let compact: boolean | null = null;
  const update = (): void => {
    const state = current();
    const shell = container.querySelector<HTMLElement>('.git-panel-shell');
    if (!state || !shell || !container.getClientRects().length) return;
    const nextCompact =
      getComputedStyle(shell).getPropertyValue('--git-single-column').trim() === '1';
    shell.classList.toggle('git-panel-detail-active', state.detailActive && !!state.selection);
    if (compact !== nextCompact) restoreScroll(container, state);
    compact = nextCompact;
    repairFocus(container, state, nextCompact, lastFocus);
  };
  container.addEventListener(
    'focusin',
    (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      lastFocus = event.target;
      const state = current();
      if (state?.selection && lastFocus.closest('.git-panel-inspector')) state.detailActive = true;
    },
    { signal: events.signal },
  );
  container.addEventListener(
    'scroll',
    (event) => {
      if (!(event.target instanceof HTMLElement) || event.target.clientHeight === 0) return;
      const key = scrollKey(event.target);
      if (key)
        current()?.scrollPositions.set(key, {
          top: event.target.scrollTop,
          left: event.target.scrollLeft,
        });
    },
    { capture: true, signal: events.signal },
  );
  const observer = new ResizeObserver(update);
  observer.observe(container);
  const controller = {
    update,
    dispose() {
      events.abort();
      observer.disconnect();
      controllers.delete(container);
    },
  };
  controllers.set(container, controller);
  update();
  return controller;
}

export function disconnectGitPanelLayout(container: HTMLElement): void {
  controllers.get(container)?.dispose();
}

export function focusGitSelection(container: HTMLElement, state: GitPanelLayoutState): void {
  selectedRow(container, state)?.focus({ preventScroll: true });
}
