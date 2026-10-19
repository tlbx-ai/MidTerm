import { t } from '../i18n';
import { readFileNavigation, type FileNavigation } from '../fileViewer/navigationApi';
import { FileNavigationHistory } from '../fileViewer/navigationHistory';
import { fetchTree, type FileTreeEntry, type FileTreeResponse } from './treeApi';
import { beginFileOpen, isFileOpenCurrent, type FileOpenRequest } from '../fileViewer/loadState';
import { createFileVisibilityControls, getFileVisibility } from '../fileViewer/visibility';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';

interface BrowserNavigationActions {
  returnToFiles: () => void;
  confirm: () => Promise<boolean>;
  apply: (path: string, data: FileTreeResponse) => void;
  file: (entry: FileTreeEntry) => Promise<boolean>;
  refilter: (path: string, data: FileTreeResponse, signal: AbortSignal) => Promise<void>;
}

function navigationShortcut(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (event.altKey && !event.ctrlKey && !event.metaKey)
    return { arrowleft: 'back', arrowright: 'forward', arrowup: 'up' }[key] ?? null;
  if (event.metaKey && !event.ctrlKey && !event.altKey)
    return { '[': 'back', ']': 'forward', arrowup: 'up' }[key] ?? null;
  return null;
}

function isAddressShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (
    ((event.ctrlKey || event.metaKey) && key === 'l') ||
    (event.altKey && key === 'd') ||
    (event.metaKey && event.shiftKey && key === 'g')
  );
}

/** Per-session address/history UI. The server defines hierarchy and authorized roots. */
export class BrowserNavigation {
  public readonly root = document.createElement('nav');
  private readonly address = document.createElement('input');
  private readonly roots = document.createElement('select');
  private readonly breadcrumbs = document.createElement('div');
  private readonly error = document.createElement('div');
  private readonly addressForm = document.createElement('form');
  private readonly eventsController = new AbortController();
  private releaseBackLayer: (() => void) | null = null;
  private readonly history = new FileNavigationHistory();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private metadata: FileNavigation | null = null;
  private controller: AbortController | null = null;
  private locationController: AbortController | null = null;
  private generation = 0;
  private cwd: string | null = null;
  private openRequest: FileOpenRequest | null = null;
  private readonly visibility = createFileVisibilityControls(() => {
    void this.refresh();
  });
  private active = false;
  private events: EventSource | null = null;
  private refreshTask: Promise<void> | null = null;
  private refreshAgain = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshController: AbortController | null = null;
  public get hasLocation(): boolean {
    return this.metadata !== null;
  }
  public get busy(): boolean {
    return this.root.getAttribute('aria-busy') === 'true';
  }

  public constructor(
    private readonly sessionId: string,
    private readonly actions: BrowserNavigationActions,
  ) {
    this.root.className = 'file-browser-navigation';
    this.root.setAttribute('aria-label', t('fileViewer.navigation'));
    const actionsRow = document.createElement('div');
    actionsRow.className = 'file-browser-navigation-actions';
    for (const action of ['back', 'forward', 'up', 'cwd', 'refresh']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.browserNavigation = action;
      button.title = t(
        action === 'cwd'
          ? 'fileBrowser.toCwd'
          : action === 'refresh'
            ? 'fileBrowser.refresh'
            : `fileViewer.${action}`,
      );
      button.setAttribute('aria-label', button.title);
      const paths: Record<string, string> = {
        back: 'M19 12H5m7-7-7 7 7 7',
        forward: 'M5 12h14m-7-7 7 7-7 7',
        up: 'M12 19V5m-7 7 7-7 7 7',
        cwd: 'm3 10 9-7 9 7v10H3Z M9 20v-7h6v7',
        refresh: 'M20 7v5h-5m5 0a8 8 0 1 0-2 6',
      };
      button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[action] ?? ''}"/></svg>`;
      button.addEventListener('click', () => {
        if (action === 'refresh') void this.refresh();
        else void this.navigateAction(action);
      });
      this.buttons.set(action, button);
      actionsRow.appendChild(button);
    }
    this.roots.setAttribute('aria-label', t('fileBrowser.availableRoots'));
    this.roots.addEventListener('change', () => {
      void this.navigate(this.roots.value);
    });
    const form = this.addressForm;
    form.className = 'file-browser-address-form';
    this.address.type = 'text';
    this.address.spellcheck = false;
    this.address.setAttribute('aria-label', t('fileBrowser.address'));
    this.address.placeholder = t('fileBrowser.address');
    this.address.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.restoreAddress();
        this.stopEditingAddress();
      }
    });
    this.address.addEventListener('blur', () => {
      if (this.address.value === this.metadata?.path) this.stopEditingAddress();
    });
    const go = document.createElement('button');
    go.type = 'submit';
    go.textContent = '→';
    go.title = t('fileBrowser.go');
    go.setAttribute('aria-label', go.title);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.navigate(this.address.value.trim());
    });
    form.append(this.address, go);
    this.breadcrumbs.className = 'file-browser-breadcrumbs';
    this.error.className = 'file-browser-navigation-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const location = document.createElement('div');
    location.className = 'file-browser-location';
    location.title = t('fileBrowser.editAddress');
    const editAddress = document.createElement('button');
    editAddress.type = 'button';
    editAddress.className = 'file-browser-edit-address';
    editAddress.textContent = '/';
    editAddress.title = t('fileBrowser.editAddress');
    editAddress.setAttribute('aria-label', editAddress.title);
    editAddress.addEventListener('click', () => {
      this.editAddress();
    });
    location.addEventListener('click', (event) => {
      if (event.target === location || event.target === this.breadcrumbs) this.editAddress();
    });
    location.append(this.breadcrumbs, form, editAddress);
    this.roots.className = 'file-browser-roots';
    actionsRow.insertBefore(this.roots, this.buttons.get('cwd') ?? null);
    actionsRow.insertBefore(location, this.buttons.get('refresh') ?? null);
    const visibilityMenu = document.createElement('details');
    visibilityMenu.className = 'file-visibility-menu';
    const visibilitySummary = document.createElement('summary');
    visibilitySummary.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    visibilitySummary.title = t('fileBrowser.visibilityOptions');
    visibilitySummary.setAttribute('aria-label', visibilitySummary.title);
    visibilityMenu.append(visibilitySummary, this.visibility.root);
    actionsRow.append(visibilityMenu);
    this.root.append(actionsRow, this.error);
    document.addEventListener(
      'keydown',
      (event) => {
        this.keydown(event);
      },
      {
        signal: this.eventsController.signal,
      },
    );
    this.syncControls();
  }

  public setCwd(path: string): void {
    this.cwd = path;
    this.syncControls();
    if (!this.metadata) void this.navigate(path);
    else void this.refreshLocation(path);
  }

  public dispose(): void {
    this.generation++;
    this.controller?.abort();
    this.locationController?.abort();
    this.visibility.dispose();
    this.setActive(false);
    this.eventsController.abort();
  }

  public setActive(active: boolean): void {
    if (active === this.active && this.events) return;
    this.active = active;
    this.releaseBackLayer?.();
    this.releaseBackLayer = active
      ? registerBackButtonLayer(() => {
          if (this.history.canBack) void this.navigateAction('back');
          else this.actions.returnToFiles();
        })
      : null;
    if (!active) {
      this.locationController?.abort();
      this.refreshController?.abort();
      this.events?.close();
      this.events = null;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    } else this.startWatching();
  }

  private startWatching(): void {
    this.events?.close();
    this.events = null;
    if (!this.active || !this.metadata) return;
    const query = new URLSearchParams({ path: this.metadata.path, sessionId: this.sessionId });
    this.events = new EventSource(`/api/files/events?${query}`);
    this.events.addEventListener('changed', () => {
      this.scheduleRefresh();
    });
    this.events.addEventListener('ready', () => {
      this.scheduleRefresh();
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || !this.active) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 500);
  }

  public async refresh(): Promise<void> {
    if (!this.active) {
      this.refreshAgain = true;
      return;
    }
    if (this.refreshTask) {
      this.refreshAgain = true;
      await this.refreshTask;
      return;
    }
    this.refreshTask = this.refilter();
    const button = this.buttons.get('refresh');
    if (button) button.disabled = true;
    try {
      await this.refreshTask;
    } finally {
      this.refreshTask = null;
      this.syncControls();
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }
  public cancelPending(): void {
    this.generation++;
    this.controller?.abort();
    this.root.setAttribute('aria-busy', 'false');
  }

  private async refreshLocation(cwd: string): Promise<void> {
    const path = this.metadata?.path;
    if (!path) return;
    this.locationController?.abort();
    const controller = new AbortController();
    this.locationController = controller;
    try {
      const next = await readFileNavigation(path, this.sessionId, controller.signal);
      if (
        !controller.signal.aborted &&
        this.root.isConnected &&
        this.cwd === cwd &&
        this.metadata?.path === path
      ) {
        this.metadata = next;
        this.renderLocation(document.activeElement === this.address);
        this.syncControls();
      }
    } catch {
      /* Keep the current view and the explicit CWD action if its metadata is unavailable. */
    }
  }

  private async navigateAction(action: string): Promise<void> {
    const path =
      action === 'back'
        ? this.history.backPath
        : action === 'forward'
          ? this.history.forwardPath
          : action === 'up'
            ? this.metadata?.parentPath
            : this.cwd;
    if (path)
      await this.navigate(path, action === 'back' || action === 'forward' ? action : 'push');
  }

  public async navigate(
    path: string,
    action: 'push' | 'back' | 'forward' = 'push',
  ): Promise<boolean> {
    if (!path) return false;
    const generation = ++this.generation;
    this.locationController?.abort();
    // Initial folder hydration belongs to this pane, even if another session opens a file.
    // Interactive navigation still invalidates superseded document opens.
    this.openRequest = this.metadata && this.active ? beginFileOpen(this.sessionId) : null;
    this.controller?.abort();
    this.controller = new AbortController();
    this.error.hidden = true;
    this.root.setAttribute('aria-busy', 'true');
    try {
      const next = await readFileNavigation(path, this.sessionId, this.controller.signal, false);
      if (!this.current(generation)) return false;
      if (!next.exists) throw new Error(t('fileViewer.fileNotFound'));
      if (!next.isDirectory) return await this.openFileLocation(next);
      return await this.openDirectoryLocation(next, action, generation, this.controller.signal);
    } catch (reason: unknown) {
      if (!this.current(generation)) return false;
      this.error.textContent =
        reason instanceof Error ? reason.message : t('fileBrowser.unableToLoad');
      this.error.hidden = false;
      return false;
    } finally {
      if (generation === this.generation) {
        this.root.setAttribute('aria-busy', 'false');
        this.syncControls();
      }
    }
  }

  private async openFileLocation(next: FileNavigation): Promise<boolean> {
    if (!next.file) return false;
    if (
      next.parentPath &&
      next.parentPath !== this.metadata?.path &&
      !(await this.navigate(next.parentPath))
    )
      return false;
    const accepted = await this.actions.file(next.file);
    this.restoreAddress();
    return accepted;
  }

  private async openDirectoryLocation(
    next: FileNavigation,
    action: 'push' | 'back' | 'forward',
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const preferences = getFileVisibility();
    const data = await fetchTree(next.path, this.sessionId, signal);
    if (!this.current(generation)) return false;
    if (!data) throw new Error(t('fileBrowser.unableToLoad'));
    if (preferences !== getFileVisibility())
      return await this.openDirectoryLocation(next, action, generation, signal);
    if (!(await this.actions.confirm()) || !this.current(generation)) {
      this.restoreAddress();
      return false;
    }
    if (action === 'back') this.history.back();
    else if (action === 'forward') this.history.forward();
    else this.history.push(next.path);
    this.metadata = next;
    this.actions.apply(next.path, data);
    this.visibility.update(data.visibility);
    this.renderLocation();
    this.startWatching();
    // Optional terminal-detected locations can involve slow/offline paths. Enrich
    // the location chooser after rendering, independently from folder navigation.
    void this.refreshLocation(this.cwd ?? next.path);
    return true;
  }

  private async refilter(): Promise<void> {
    const path = this.metadata?.path;
    if (!path) return;
    const preferences = getFileVisibility();
    const controller = new AbortController();
    this.refreshController = controller;
    this.error.hidden = true;
    const data = await fetchTree(path, this.sessionId, controller.signal);
    if (
      this.active &&
      !controller.signal.aborted &&
      this.root.isConnected &&
      this.metadata?.path === path &&
      getFileVisibility() === preferences
    ) {
      if (!data) {
        this.error.textContent = t('fileBrowser.unableToLoad');
        this.error.hidden = false;
        return;
      }
      await this.actions.refilter(path, data, controller.signal);
      this.visibility.update(data.visibility);
    }
  }

  private current(generation: number): boolean {
    return (
      generation === this.generation &&
      this.root.isConnected &&
      (!this.openRequest || isFileOpenCurrent(this.openRequest))
    );
  }
  private restoreAddress(): void {
    this.address.value = this.metadata?.path ?? '';
    this.roots.value = this.metadata?.path ?? '';
  }

  private editAddress(): void {
    this.root.dataset.editingAddress = 'true';
    this.address.value = this.metadata?.path ?? '';
    this.address.focus();
    this.address.select();
  }

  private stopEditingAddress(): void {
    this.root.dataset.editingAddress = 'false';
    this.root.querySelector<HTMLButtonElement>('.file-browser-edit-address')?.focus();
  }

  private keydown(event: KeyboardEvent): void {
    if (
      !this.active ||
      event.defaultPrevented ||
      event.isComposing ||
      document.querySelector('.modal-overlay, .file-unsaved-overlay, .modal:not(.hidden)')
    )
      return;
    const key = event.key.toLowerCase();
    const editing =
      event.target instanceof HTMLElement &&
      !!event.target.closest('textarea, input, [contenteditable="true"]');
    const action = navigationShortcut(event);
    if (action && !editing) {
      event.preventDefault();
      void this.navigateAction(action);
    } else if (isAddressShortcut(event)) {
      event.preventDefault();
      this.editAddress();
    } else if (key === 'f5' && this.root.parentElement?.contains(document.activeElement)) {
      event.preventDefault();
      void this.refresh();
    }
  }

  private renderLocation(preserveAddress = false): void {
    if (!this.metadata) return;
    if (!preserveAddress) this.restoreAddress();
    if (!preserveAddress) this.root.dataset.editingAddress = 'false';
    this.roots.replaceChildren();
    const location = document.createElement('option');
    location.value = this.metadata.path;
    location.textContent = t('fileBrowser.locations');
    this.roots.title = t('fileBrowser.availableRoots');
    this.roots.appendChild(location);
    for (const root of this.metadata.roots) {
      const option = document.createElement('option');
      option.value = root.path;
      option.textContent = `${root.name} — ${root.path}`;
      this.roots.appendChild(option);
    }
    this.breadcrumbs.replaceChildren();
    for (const [index, location] of this.metadata.breadcrumbs.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = index === 0 ? location.path : location.name;
      button.title = location.path;
      button.dataset.breadcrumbPath = location.path;
      button.addEventListener('click', () => {
        void this.navigate(location.path);
      });
      if (location.path === this.metadata.path) button.setAttribute('aria-current', 'location');
      this.breadcrumbs.appendChild(button);
    }
    this.breadcrumbs.title = this.metadata.path;
    requestAnimationFrame(() => {
      this.breadcrumbs.scrollLeft = this.breadcrumbs.scrollWidth;
    });
  }

  private syncControls(): void {
    const enabled = {
      back: this.history.canBack,
      forward: this.history.canForward,
      up: !!this.metadata?.parentPath,
      cwd: !!this.cwd && this.cwd !== this.metadata?.path,
      refresh: !!this.metadata && !this.refreshTask,
    };
    for (const [action, button] of this.buttons)
      button.disabled = !enabled[action as keyof typeof enabled];
    const cwdButton = this.buttons.get('cwd');
    if (cwdButton) {
      cwdButton.hidden = !enabled.cwd;
      cwdButton.title = `${t('fileBrowser.toCwd')}: ${this.cwd ?? ''}`;
    }
    for (const action of ['back', 'forward', 'up']) {
      const button = this.buttons.get(action);
      if (!button) continue;
      const path =
        action === 'back'
          ? this.history.backPath
          : action === 'forward'
            ? this.history.forwardPath
            : this.metadata?.parentPath;
      button.title = `${t(`fileViewer.${action}`)}${path ? `: ${path}` : ''}`;
    }
  }
}
