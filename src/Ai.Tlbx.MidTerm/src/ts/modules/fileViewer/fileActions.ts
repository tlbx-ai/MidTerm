import { $activeSessionId } from '../../stores';
import { t } from '../i18n';
import { confirmFileMutation } from './editState';
import { operationDialog } from './operationDialog';
import {
  executeOperation,
  FileOperationError,
  listRecovery,
  restoreEntry,
  type OperationResult,
  type OperationRequest,
} from './operationsApi';
import type { SelectedFile } from './selectionToolbar';
import { joinPath, getFileName } from './rendering';

export interface FileActionContext {
  owner: HTMLElement;
  sessionId: () => string | null;
  directory: () => string;
  selected: () => SelectedFile[];
  changed: (result: OperationResult) => Promise<void>;
  select: (paths: string[]) => void;
}
interface ClipboardFiles {
  mode: 'copy' | 'move';
  paths: string[];
}
let clipboard: ClipboardFiles | null = null;
const clipboardListeners = new Set<() => void>();
const mutationActions = [
  'createFile',
  'createFolder',
  'rename',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'move',
  'delete',
  'undo',
  'recovery',
] as const;
type Action = (typeof mutationActions)[number];
interface Snapshot {
  sessionId: string;
  directory: string;
  files: SelectedFile[];
}

export class FileActions {
  public readonly root = document.createElement('details');
  private readonly status = document.createElement('div');
  private readonly buttons = new Map<Action, HTMLButtonElement>();
  private busy = false;
  private undo: string[] = [];
  private closeContext: (() => void) | null = null;
  private popupEvents: AbortController | null = null;
  private popupObserver: ResizeObserver | null = null;
  private readonly clipboardChanged = (): void => {
    if (this.context.owner.isConnected) this.update();
  };

  public constructor(private context: FileActionContext) {
    this.root.className = 'file-actions-menu';
    const summary = document.createElement('summary');
    summary.textContent = '⋯';
    summary.title = t('fileBrowser.actions');
    summary.setAttribute('aria-label', summary.title);
    this.root.append(summary);
    const menu = document.createElement('div');
    menu.className = 'file-actions-list';
    for (const action of mutationActions) {
      const button = this.button(action);
      this.buttons.set(action, button);
      menu.append(button);
    }
    this.root.append(menu);
    this.root.addEventListener('toggle', () => {
      this.popupEvents?.abort();
      this.popupObserver?.disconnect();
      if (!this.root.open) return;
      const pane =
        this.context.owner.closest<HTMLElement>(
          '.file-browser-tree, .file-viewer-body, .file-viewer-dock-body',
        ) ?? this.context.owner;
      const place = (): void => {
        this.placePopup(menu, pane);
      };
      place();
      this.popupEvents = new AbortController();
      window.addEventListener('resize', place, { signal: this.popupEvents.signal });
      this.popupObserver = new ResizeObserver(place);
      this.popupObserver.observe(pane);
    });
    this.status.className = 'file-operation-status';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    clipboardListeners.add(this.clipboardChanged);
    this.context.owner.addEventListener('keydown', (event) => {
      this.keyboard(event);
    });
  }

  public attach(toolbar: HTMLElement): void {
    const readingActions = toolbar.querySelector('.file-selection-read-actions');
    if (readingActions) this.root.querySelector('.file-actions-list')?.prepend(readingActions);
    toolbar.append(this.root);
    toolbar.after(this.status);
    this.update();
  }
  public dispose(): void {
    this.popupEvents?.abort();
    this.popupObserver?.disconnect();
    clipboardListeners.delete(this.clipboardChanged);
    this.closeContext?.();
  }

  private placePopup(menu: HTMLElement, pane: HTMLElement): void {
    menu.style.left = '0px';
    menu.style.top = '100%';
    menu.style.bottom = 'auto';
    menu.style.maxHeight = '';
    const box = pane.getBoundingClientRect(),
      anchor = this.root.getBoundingClientRect();
    const right = Math.min(innerWidth, box.left + pane.clientLeft + pane.clientWidth);
    menu.style.maxWidth = `${Math.max(180, pane.clientWidth - 16)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(0, right - rect.right - 8)}px`;
    let available =
      Math.min(innerHeight, box.top + pane.clientTop + pane.clientHeight) - rect.top - 8;
    if (available < 88 && anchor.top - box.top > available) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
      available = anchor.top - Math.max(0, box.top) - 8;
    }
    menu.style.maxHeight = `${Math.max(44, Math.min(innerHeight * 0.65, available))}px`;
  }

  private button(action: Action): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fileAction = action;
    button.textContent = t(`fileBrowser.${action}`);
    button.addEventListener('click', () => {
      this.root.open = false;
      this.closeContext?.();
      void this.run(action);
    });
    return button;
  }

  public update(): void {
    const count = this.context.selected().length;
    for (const [action, button] of this.buttons) {
      button.disabled = this.disabled(action, count);
    }
  }
  private disabled(action: Action, count: number): boolean {
    if (this.busy || !this.context.sessionId() || !this.context.directory()) return true;
    if (action === 'rename') return count !== 1;
    if (action === 'paste') return !clipboard?.paths.length;
    if (action === 'undo') return this.undo.length === 0;
    return !['createFile', 'createFolder', 'recovery'].includes(action) && count === 0;
  }

  public showContext(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeContext?.();
    const previous = document.activeElement;
    const menu = document.createElement('div');
    menu.className = 'file-context-menu';
    for (const action of mutationActions) {
      const button = this.button(action);
      button.disabled = this.disabled(action, this.context.selected().length);
      menu.append(button);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - rect.height - 4))}px`;
    const controller = new AbortController();
    this.closeContext = () => {
      controller.abort();
      menu.remove();
      this.closeContext = null;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!menu.contains(e.target as Node)) this.closeContext?.();
      },
      { signal: controller.signal },
    );
    menu.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeContext?.();
      }
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  private snapshot(): Snapshot | null {
    const sessionId = this.context.sessionId();
    if (!sessionId || $activeSessionId.get() !== sessionId || !this.context.owner.isConnected)
      return null;
    return {
      sessionId,
      directory: this.context.directory(),
      files: this.context.selected().map((file) => ({ ...file })),
    };
  }
  private current(snapshot: Snapshot): boolean {
    return (
      this.context.owner.isConnected &&
      $activeSessionId.get() === snapshot.sessionId &&
      this.context.sessionId() === snapshot.sessionId &&
      this.context.directory() === snapshot.directory
    );
  }

  private async run(action: Action): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || this.disabled(action, snapshot.files.length)) return;
    if (['copy', 'cut'].includes(action)) {
      clipboard = {
        mode: action === 'cut' ? 'move' : 'copy',
        paths: snapshot.files.map((file) => file.path),
      };
      clipboardListeners.forEach((listener) => {
        listener();
      });
      this.message(t('fileBrowser.clipboardReady'));
      return;
    }
    this.busy = true;
    this.update();
    try {
      if (action === 'recovery') {
        await this.recovery(snapshot);
        return;
      }
      if (action === 'undo') {
        await this.restore(snapshot, this.undo);
        return;
      }
      const request = await this.prepare(action, snapshot);
      if (!request || !this.current(snapshot)) return;
      if (
        ['rename', 'move', 'delete'].includes(request.action) &&
        !(await confirmFileMutation(snapshot.sessionId, request.paths))
      )
        return;
      if (!this.current(snapshot)) return;
      this.message(t('fileBrowser.operationRunning'));
      const result = await this.resolveConflicts(
        request,
        snapshot,
        await executeOperation(request, snapshot.sessionId),
      );
      await this.acceptResult(action, request, snapshot, result);
    } catch (error) {
      if (this.current(snapshot))
        this.message(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.busy = false;
      this.update();
    }
  }

  private async resolveConflicts(
    request: OperationRequest,
    snapshot: Snapshot,
    result: OperationResult,
  ): Promise<OperationResult> {
    const conflicts = result.items.filter((item) => !item.success && item.code === 'name_conflict');
    if (conflicts.length && this.current(snapshot)) {
      const decision = await operationDialog(
        t('fileBrowser.nameConflict'),
        conflicts.map((item) => item.sourcePath ?? request.name ?? '').join('\n'),
        [
          { value: 'keepBoth', label: t('fileBrowser.keepBoth') },
          { value: 'replace', label: t('fileBrowser.replaceEntirely'), danger: true },
        ],
      );
      if (decision && this.current(snapshot)) {
        const failedPaths = conflicts
          .map((item) => item.sourcePath)
          .filter((path): path is string => !!path);
        if (
          decision.action === 'replace' &&
          !(await confirmFileMutation(
            snapshot.sessionId,
            conflicts.map((item) =>
              joinPath(
                request.destinationDirectory ??
                  (request.action === 'rename'
                    ? (item.sourcePath ?? '').replace(/[\\/][^\\/]+$/, '')
                    : snapshot.directory),
                request.name ?? getFileName(item.sourcePath ?? ''),
              ),
            ),
          ))
        )
          return result;
        const retry = {
          ...request,
          requestId: crypto.randomUUID(),
          paths: failedPaths.length ? failedPaths : request.paths,
          conflict: decision.action,
        };
        const retried = await executeOperation(retry, snapshot.sessionId);
        result = {
          ...result,
          items: [
            ...result.items.filter((item) => item.success || item.code !== 'name_conflict'),
            ...retried.items,
          ],
        };
      }
    }
    return result;
  }

  private async acceptResult(
    action: Action,
    request: OperationRequest,
    snapshot: Snapshot,
    result: OperationResult,
  ): Promise<void> {
    this.undo =
      request.action === 'delete'
        ? [
            ...new Set(
              result.items
                .filter((item) => item.success)
                .map((item) => item.recoveryId)
                .filter((id): id is string => !!id),
            ),
          ]
        : this.undo;
    if (action === 'paste' && clipboard?.mode === 'move') {
      const remaining = new Set(
        result.items.filter((item) => !item.success).map((item) => item.sourcePath),
      );
      clipboard.paths = clipboard.paths.filter((path) => remaining.has(path));
      if (!clipboard.paths.length) clipboard = null;
      clipboardListeners.forEach((listener) => {
        listener();
      });
    }
    if (this.current(snapshot)) {
      await this.context.changed(result);
      if (!this.current(snapshot)) return;
      this.context.select(
        result.items
          .map((item) => (item.success ? item.path : item.sourcePath))
          .filter((path): path is string => !!path),
      );
      this.report(result);
    }
  }

  private async prepare(action: Action, snapshot: Snapshot): Promise<OperationRequest | null> {
    const paths = snapshot.files.map((file) => file.path);
    const request: OperationRequest = {
      requestId: crypto.randomUUID(),
      action,
      paths,
      conflict: 'fail',
    };
    if (['createFile', 'createFolder', 'rename'].includes(action)) {
      const first = paths[0] ?? '';
      const name = first.split(/[\\/]/).pop() ?? '';
      const decision = await operationDialog(
        t(`fileBrowser.${action}`),
        action === 'rename' ? first : snapshot.directory,
        [{ value: 'apply', label: t('fileBrowser.apply') }],
        { label: t('fileBrowser.name'), value: action === 'rename' ? name : '' },
      );
      if (!decision) return null;
      request.name = decision.value;
      if (action !== 'rename') {
        request.paths = [];
        request.destinationDirectory = snapshot.directory;
      }
    } else if (action === 'move') {
      const decision = await operationDialog(
        t('fileBrowser.move'),
        paths.join('\n'),
        [{ value: 'apply', label: t('fileBrowser.move') }],
        { label: t('fileBrowser.destination'), value: snapshot.directory },
      );
      if (!decision) return null;
      request.destinationDirectory = decision.value;
    } else if (action === 'delete') {
      if (
        !(await operationDialog(
          t('fileBrowser.delete'),
          `${t('fileBrowser.recoverableDelete')}\n${paths.join('\n')}`,
          [{ value: 'delete', label: t('fileBrowser.delete'), danger: true }],
        ))
      )
        return null;
    } else if (action === 'paste' && clipboard) {
      request.action = clipboard.mode;
      request.paths = [...clipboard.paths];
      request.destinationDirectory = snapshot.directory;
      // The owner explicitly selected these locations; registration keeps clipboard usable across windows/sessions.
      const parents = [...new Set(request.paths.map((path) => path.replace(/[\\/][^\\/]+$/, '')))];
      const registered = await fetch('/api/files/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: snapshot.sessionId, paths: parents }),
      });
      if (!registered.ok) throw new FileOperationError('access_denied');
    }
    return request;
  }

  private async restore(snapshot: Snapshot, ids: string[]): Promise<boolean> {
    const items = [];
    for (const id of ids) {
      if (!this.current(snapshot)) return false;
      try {
        items.push(await restoreEntry(id, snapshot.sessionId));
      } catch (error) {
        if (!(error instanceof FileOperationError) || error.code !== 'name_conflict') throw error;
        const decision = await operationDialog(
          t('fileBrowser.nameConflict'),
          t('fileBrowser.restoreCollision'),
          [{ value: 'keepBoth', label: t('fileBrowser.keepBoth') }],
        );
        if (!decision || !this.current(snapshot)) return false;
        items.push(await restoreEntry(id, snapshot.sessionId, 'keepBoth'));
      }
    }
    const result: OperationResult = { operationId: '', action: 'restore', complete: true, items };
    const restored = new Set(items.map((item) => item.recoveryId));
    this.undo = this.undo.filter((id) => !restored.has(id));
    if (this.current(snapshot)) {
      await this.context.changed(result);
      if (!this.current(snapshot)) return false;
      this.context.select(
        result.items.map((item) => item.path).filter((path): path is string => !!path),
      );
      this.report(result);
    }
    return true;
  }

  private async recovery(snapshot: Snapshot): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await listRecovery(snapshot.directory, snapshot.sessionId, cursor);
      if (!this.current(snapshot)) return;
      if (!page.entries.length) {
        this.message(t('fileBrowser.recoveryEmpty'));
        return;
      }
      const choices = [{ value: 'restore', label: t('fileBrowser.restore') }];
      if (page.nextCursor) choices.push({ value: 'next', label: t('fileBrowser.nextPage') });
      const decision = await operationDialog(
        t('fileBrowser.recovery'),
        t('fileBrowser.recoveryHelp'),
        choices,
        {
          label: t('fileBrowser.deletedEntry'),
          value: page.entries[0]?.id ?? '',
          options: page.entries.map((entry) => ({
            value: entry.id,
            label: `${entry.originalPath} · ${new Date(entry.createdAt).toLocaleString()}`,
          })),
        },
      );
      if (!decision) return;
      if (decision.action === 'restore') {
        await this.restore(snapshot, [decision.value]);
        return;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && this.current(snapshot));
  }

  private report(result: OperationResult): void {
    const failed = result.items.filter((item) => !item.success);
    this.message(
      failed.length
        ? failed
            .map(
              (item) =>
                `${item.sourcePath ?? ''}: ${item.message ?? item.code ?? t('fileBrowser.operationFailed')}`,
            )
            .join('\n')
        : t('fileBrowser.operationCompleted'),
      failed.length > 0,
    );
  }
  private message(message: string, error = false): void {
    this.status.hidden = false;
    this.status.textContent = message;
    this.status.setAttribute('role', error ? 'alert' : 'status');
  }

  private keyboard(event: KeyboardEvent): void {
    if (
      (event.target as HTMLElement).closest(
        'input, textarea, button, summary, .file-browser-preview',
      )
    )
      return;
    const modifier = event.ctrlKey || event.metaKey;
    let action: Action | undefined;
    if (modifier && event.key.toLowerCase() === 'c') action = 'copy';
    else if (modifier && event.key.toLowerCase() === 'x') action = 'cut';
    else if (modifier && event.key.toLowerCase() === 'v') action = 'paste';
    else if (event.key === 'F2') action = 'rename';
    else if (event.key === 'Delete') action = 'delete';
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    void this.run(action);
  }
}
