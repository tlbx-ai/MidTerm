import { t } from '../i18n';
import { readFileNavigation, type FileNavigation } from '../fileViewer/navigationApi';
import { FileNavigationHistory } from '../fileViewer/navigationHistory';
import { fetchTree, type FileTreeEntry, type FileTreeResponse } from './treeApi';
import { beginFileOpen, isFileOpenCurrent, type FileOpenRequest } from '../fileViewer/loadState';

interface BrowserNavigationActions {
  confirm: () => Promise<boolean>;
  apply: (path: string, data: FileTreeResponse) => void;
  file: (entry: FileTreeEntry) => Promise<boolean>;
}

/** Per-session address/history UI. The server defines hierarchy and authorized roots. */
export class BrowserNavigation {
  public readonly root = document.createElement('nav');
  private readonly address = document.createElement('input');
  private readonly roots = document.createElement('select');
  private readonly breadcrumbs = document.createElement('div');
  private readonly error = document.createElement('div');
  private readonly history = new FileNavigationHistory();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private metadata: FileNavigation | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private cwd: string | null = null;
  private openRequest: FileOpenRequest | null = null;
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
    for (const action of ['back', 'forward', 'up', 'cwd']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.browserNavigation = action;
      button.textContent = t(action === 'cwd' ? 'fileBrowser.toCwd' : `fileViewer.${action}`);
      button.addEventListener('click', () => {
        void this.navigateAction(action);
      });
      this.buttons.set(action, button);
      actionsRow.appendChild(button);
    }
    this.roots.setAttribute('aria-label', t('fileBrowser.availableRoots'));
    this.roots.addEventListener('change', () => {
      void this.navigate(this.roots.value);
    });
    actionsRow.appendChild(this.roots);
    const form = document.createElement('form');
    form.className = 'file-browser-address-form';
    this.address.type = 'text';
    this.address.spellcheck = false;
    this.address.setAttribute('aria-label', t('fileBrowser.address'));
    this.address.placeholder = t('fileBrowser.address');
    this.address.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.address.value = this.metadata?.path ?? '';
        this.address.blur();
      }
    });
    const go = document.createElement('button');
    go.type = 'submit';
    go.textContent = t('fileBrowser.go');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.navigate(this.address.value.trim());
    });
    form.append(this.address, go);
    this.breadcrumbs.className = 'file-browser-breadcrumbs';
    this.error.className = 'file-browser-navigation-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    this.root.append(actionsRow, form, this.breadcrumbs, this.error);
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
  }
  public cancelPending(): void {
    this.generation++;
    this.controller?.abort();
    this.root.setAttribute('aria-busy', 'false');
  }

  private async refreshLocation(cwd: string): Promise<void> {
    const path = this.metadata?.path;
    if (!path) return;
    try {
      const next = await readFileNavigation(path, this.sessionId, new AbortController().signal);
      if (this.root.isConnected && this.cwd === cwd && this.metadata?.path === path) {
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
    this.openRequest = beginFileOpen(this.sessionId);
    this.controller?.abort();
    this.controller = new AbortController();
    this.error.hidden = true;
    this.root.setAttribute('aria-busy', 'true');
    try {
      const next = await readFileNavigation(path, this.sessionId, this.controller.signal);
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
    const data = await fetchTree(next.path, this.sessionId, signal);
    if (!this.current(generation)) return false;
    if (!data) throw new Error(t('fileBrowser.unableToLoad'));
    if (!(await this.actions.confirm()) || !this.current(generation)) {
      this.restoreAddress();
      return false;
    }
    if (action === 'back') this.history.back();
    else if (action === 'forward') this.history.forward();
    else this.history.push(next.path);
    this.metadata = next;
    this.actions.apply(next.path, data);
    this.renderLocation();
    return true;
  }

  private current(generation: number): boolean {
    return (
      generation === this.generation &&
      this.root.isConnected &&
      !!this.openRequest &&
      isFileOpenCurrent(this.openRequest)
    );
  }
  private restoreAddress(): void {
    this.address.value = this.metadata?.path ?? '';
    this.roots.value = this.metadata?.path ?? '';
  }

  private renderLocation(preserveAddress = false): void {
    if (!this.metadata) return;
    if (!preserveAddress) this.restoreAddress();
    this.roots.replaceChildren();
    const location = document.createElement('option');
    location.value = this.metadata.path;
    location.textContent =
      this.metadata.roots.find((root) => root.path === this.metadata?.path)?.name ??
      this.metadata.breadcrumbs[this.metadata.breadcrumbs.length - 1]?.name ??
      this.metadata.path;
    this.roots.title = this.metadata.path;
    this.roots.appendChild(location);
    for (const root of this.metadata.roots) {
      if (root.path === this.metadata.path) continue;
      const option = document.createElement('option');
      option.value = root.path;
      option.textContent = `${root.name} — ${root.path}`;
      this.roots.appendChild(option);
    }
    this.breadcrumbs.replaceChildren();
    for (const location of this.metadata.breadcrumbs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = location.name;
      button.title = location.path;
      button.dataset.breadcrumbPath = location.path;
      button.addEventListener('click', () => {
        void this.navigate(location.path);
      });
      if (location.path === this.metadata.path) button.setAttribute('aria-current', 'location');
      this.breadcrumbs.appendChild(button);
    }
  }

  private syncControls(): void {
    const enabled = {
      back: this.history.canBack,
      forward: this.history.canForward,
      up: !!this.metadata?.parentPath,
      cwd: !!this.cwd && this.cwd !== this.metadata?.path,
    };
    for (const [action, button] of this.buttons)
      button.disabled = !enabled[action as keyof typeof enabled];
    const cwdButton = this.buttons.get('cwd');
    if (cwdButton) cwdButton.title = this.cwd ?? '';
  }
}
