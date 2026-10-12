import type { DirectoryEntry } from '../../types';
import { reconcileKeyedChildren } from '../../utils/domReconcile';
import { FileSelectionSurface } from './selectionSurface';
import { createSelectionToolbar } from './selectionToolbar';
import { getFileIcon, formatSize, joinPath } from './rendering';
import { t } from '../i18n';
import { FileActions } from './fileActions';
import type { OperationResult } from './operationsApi';
import {
  createListingControls,
  createListingHeader,
  fileType,
  matchesListing,
  modifiedLabel,
  sortListing,
  type FileViewOptions,
  type ListingControls,
  type ListingHeader,
} from './listingView';

export class DirectoryListing {
  public readonly root = document.createElement('div');
  public readonly surface: FileSelectionSurface;
  private entries = new Map<string, DirectoryEntry>();
  private list = document.createElement('div');
  private toolbar: ReturnType<typeof createSelectionToolbar>;
  private actions: FileActions;
  private controls: ListingControls;
  private header: ListingHeader;
  private view: FileViewOptions;
  private allEntries: DirectoryEntry[] = [];
  private visibilityFiltered = false;
  private retainedSelection: string[] = [];
  private retainedAnchor: string | null = null;
  private rendering = false;

  public constructor(
    public readonly path: string,
    sessionId: string | null,
    private open: (path: string) => void,
    changed: (result: OperationResult) => Promise<void>,
  ) {
    this.root.className = 'file-directory-listing';
    this.list.className = 'file-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', t('fileBrowser.files'));
    this.list.setAttribute('aria-multiselectable', 'true');
    this.surface = new FileSelectionSurface(
      () => [...this.list.querySelectorAll<HTMLElement>('.file-list-item')],
      () => {
        if (!this.rendering) {
          this.retainedSelection = [...this.surface.selection.paths];
          this.retainedAnchor = this.surface.selection.anchorPath;
        }
        this.toolbar.update();
        this.actions.update();
      },
      open,
    );
    this.toolbar = createSelectionToolbar(
      () =>
        [...this.surface.selection.paths].map((path) => ({
          path,
          isDirectory: this.entries.get(path)?.isDirectory ?? true,
        })),
      open,
      () => sessionId,
    );
    this.controls = createListingControls(
      `directory:${sessionId ?? 'shared'}`,
      false,
      (options) => {
        this.view = options;
        this.renderView();
      },
    );
    this.view = this.controls.options;
    this.header = createListingHeader((sort) => {
      this.controls.setSort(sort);
    });
    this.root.append(this.toolbar.root, this.controls.root, this.header.root, this.list);
    this.actions = new FileActions({
      owner: this.root,
      sessionId: () => sessionId,
      directory: () => path,
      selected: () =>
        [...this.surface.selection.paths].map((path) => ({
          path,
          isDirectory: this.entries.get(path)?.isDirectory ?? true,
        })),
      changed,
      select: (paths) => {
        this.retainedSelection = [...paths];
        this.retainedAnchor = paths[0] ?? null;
        this.surface.selection.restore(paths);
        this.surface.update();
      },
    });
    this.actions.attach(this.toolbar.root);
  }

  public dispose(): void {
    this.actions.dispose();
  }

  public render(entries: DirectoryEntry[], filtered: boolean): void {
    const restored = [...this.surface.selection.paths];
    if (restored.length > 0) {
      this.retainedSelection = [...new Set([...this.retainedSelection, ...restored])];
      this.retainedAnchor = this.surface.selection.anchorPath;
    }
    this.allEntries = entries;
    this.visibilityFiltered = filtered;
    this.entries = new Map(entries.map((entry) => [joinPath(this.path, entry.name), entry]));
    this.retainedSelection = this.retainedSelection.filter((path) => this.entries.has(path));
    this.renderView();
  }

  private renderView(): void {
    const entries = sortListing(
      this.allEntries.filter((entry) => matchesListing(entry, this.view.query)),
      this.view,
    );
    this.list.className = `file-list file-listing-${this.view.mode}`;
    this.header.update(this.view);
    this.controls.setCount(entries.length, this.allEntries.length);
    reconcileKeyedChildren(this.list, entries, {
      key: (entry) => joinPath(this.path, entry.name),
      create: () => this.createRow(),
      patch: (row, entry) => {
        this.patchRow(row, entry);
      },
    });
    this.root.querySelector('.file-list-empty')?.remove();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-list-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = t(
        this.view.query
          ? 'fileBrowser.noMatches'
          : this.visibilityFiltered
            ? 'fileBrowser.allFiltered'
            : 'fileViewer.emptyDirectory',
      );
      this.root.append(empty);
    }
    this.rendering = true;
    this.surface.selection.restore(this.retainedSelection, this.retainedAnchor);
    this.surface.update();
    this.rendering = false;
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.className = 'file-entry-label';
    const metadata = document.createElement('span');
    metadata.className = 'file-entry-metadata';
    for (const className of [
      'file-icon',
      'file-name',
      'file-visibility-badge',
      'file-type',
      'file-modified',
      'file-size',
    ]) {
      const span = document.createElement('span');
      span.className = className;
      if (className === 'file-name' || className === 'file-visibility-badge') label.append(span);
      else if (['file-type', 'file-modified', 'file-size'].includes(className))
        metadata.append(span);
      else row.append(span);
    }
    row.querySelector('.file-icon')?.after(label);
    row.append(metadata);
    this.surface.bind(row);
    row.addEventListener('click', (event) => {
      this.surface.choose(row, event.ctrlKey || event.metaKey, event.shiftKey);
      row.focus({ preventScroll: true });
    });
    row.addEventListener('dblclick', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const path = row.dataset.path;
      if (path) this.open(path);
    });
    row.addEventListener('contextmenu', (event) => {
      if (!this.surface.selection.paths.has(row.dataset.path ?? '')) this.surface.choose(row);
      this.actions.showContext(event);
    });
    return row;
  }

  private patchRow(row: HTMLElement, entry: DirectoryEntry): void {
    row.className = `file-list-item ${entry.isDirectory ? 'file-list-dir' : 'file-list-file'}`;
    row.dataset.path = joinPath(this.path, entry.name);
    row.dataset.isDir = String(entry.isDirectory);
    this.surface.label(row, entry.name);
    const values = [
      getFileIcon(entry.name, entry.isDirectory),
      entry.name,
      [
        entry.isHidden ? t('fileBrowser.hidden') : '',
        entry.isIgnored ? t('fileBrowser.ignored') : '',
      ]
        .filter(Boolean)
        .join(', '),
      fileType(entry),
      modifiedLabel(entry),
      !entry.isDirectory && entry.size != null ? formatSize(entry.size) : '',
    ];
    [
      'file-icon',
      'file-name',
      'file-visibility-badge',
      'file-type',
      'file-modified',
      'file-size',
    ].forEach((className, index) => {
      const span = row.querySelector<HTMLElement>(`.${className}`);
      if (span) {
        span.textContent = values[index] ?? '';
        span.hidden = !span.textContent;
      }
    });
  }
}
