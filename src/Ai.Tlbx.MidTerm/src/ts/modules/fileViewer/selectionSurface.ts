import { FileSelection } from './selection';
import { t } from '../i18n';

/** Shared keyboard and touch selection. Opening is always an explicit callback. */
export class FileSelectionSurface {
  public readonly selection = new FileSelection();
  public revision = 0;
  public constructor(
    private rows: () => HTMLElement[],
    private changed: () => void,
    private open: (path: string) => void,
  ) {}

  public choose(row: HTMLElement, toggle = false, range = false): void {
    const path = row.dataset.path;
    if (!path) return;
    this.revision++;
    this.selection.select(
      path,
      this.rows().map((item) => item.dataset.path ?? ''),
      toggle,
      range,
    );
    this.update();
  }

  public update(): void {
    const rows = this.rows();
    this.selection.retain(rows.map((row) => row.dataset.path ?? ''));
    const current =
      rows.find((row) => row === document.activeElement) ??
      rows.find((row) => this.selection.paths.has(row.dataset.path ?? '')) ??
      rows[0];
    rows.forEach((row) => {
      const selected = this.selection.paths.has(row.dataset.path ?? '');
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = row === current ? 0 : -1;
      const checkbox = row.querySelector<HTMLInputElement>('.file-selection-checkbox');
      if (checkbox) checkbox.checked = selected;
    });
    this.changed();
  }

  public bind(row: HTMLElement): void {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.tabIndex = -1;
    checkbox.className = 'file-selection-checkbox';
    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
      this.choose(row, true, event.shiftKey);
    });
    checkbox.addEventListener('dblclick', (event) => {
      event.stopPropagation();
    });
    row.prepend(checkbox);
    row.addEventListener('keydown', (event) => {
      this.key(event, row);
    });
  }

  public label(row: HTMLElement, name: string): void {
    row
      .querySelector('.file-selection-checkbox')
      ?.setAttribute('aria-label', `${t('fileBrowser.select')} ${name}`);
  }

  private key(event: KeyboardEvent, row: HTMLElement): void {
    const rows = this.rows(),
      index = rows.indexOf(row);
    const toggle = event.ctrlKey || event.metaKey;
    if (toggle && event.key.toLowerCase() === 'a') {
      this.revision++;
      this.selection.restore(rows.map((item) => item.dataset.path ?? ''));
      this.update();
    } else if (event.key === 'Enter') {
      const path = row.dataset.path;
      if (path && this.selection.paths.size === 1 && this.selection.paths.has(path))
        this.open(path);
    } else if (event.key === ' ') {
      this.choose(row, toggle, event.shiftKey);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const next = this.nextRow(rows, index, event.key);
      if (!next) return;
      if (!toggle || event.shiftKey) this.choose(next, toggle, event.shiftKey);
      next.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  private nextRow(rows: HTMLElement[], index: number, key: string): HTMLElement | undefined {
    if (key === 'Home') return rows[0];
    if (key === 'End') return rows[rows.length - 1];
    return rows[Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowUp' ? -1 : 1)))];
  }
}
