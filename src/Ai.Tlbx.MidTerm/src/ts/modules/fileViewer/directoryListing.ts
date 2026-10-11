import type { DirectoryEntry } from '../../types';
import { reconcileKeyedChildren } from '../../utils/domReconcile';
import { FileSelectionSurface } from './selectionSurface';
import { createSelectionToolbar } from './selectionToolbar';
import { getFileIcon, formatSize, joinPath } from './rendering';
import { t } from '../i18n';

export class DirectoryListing {
  public readonly root = document.createElement('div');
  public readonly surface: FileSelectionSurface;
  private entries = new Map<string, DirectoryEntry>();
  private list = document.createElement('div');
  private toolbar: ReturnType<typeof createSelectionToolbar>;

  public constructor(
    public readonly path: string,
    sessionId: string | null,
    private open: (path: string) => void,
  ) {
    this.root.className = 'file-directory-listing';
    this.list.className = 'file-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', t('fileBrowser.files'));
    this.list.setAttribute('aria-multiselectable', 'true');
    this.surface = new FileSelectionSurface(
      () => [...this.list.querySelectorAll<HTMLElement>('.file-list-item')],
      () => {
        this.toolbar.update();
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
    this.root.append(this.toolbar.root, this.list);
  }

  public render(entries: DirectoryEntry[], filtered: boolean): void {
    this.entries = new Map(entries.map((entry) => [joinPath(this.path, entry.name), entry]));
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
      empty.textContent = t(filtered ? 'fileBrowser.allFiltered' : 'fileViewer.emptyDirectory');
      this.root.append(empty);
    }
    this.surface.update();
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    for (const className of ['file-icon', 'file-name', 'file-visibility-badge', 'file-size']) {
      const span = document.createElement('span');
      span.className = className;
      row.append(span);
    }
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
      !entry.isDirectory && entry.size != null ? formatSize(entry.size) : '',
    ];
    ['file-icon', 'file-name', 'file-visibility-badge', 'file-size'].forEach((className, index) => {
      const span = row.querySelector<HTMLElement>(`.${className}`);
      if (span) {
        span.textContent = values[index] ?? '';
        span.hidden = !span.textContent;
      }
    });
  }
}
