import { getCurrentLocale, t } from '../i18n';

export type FileViewMode = 'tree' | 'details' | 'icons';
export type FileSort = 'name' | 'modified' | 'type' | 'size';
export interface FileViewOptions {
  mode: FileViewMode;
  sort: FileSort;
  descending: boolean;
  query: string;
}
export interface ListingEntry {
  name: string;
  isDirectory: boolean;
  size?: number | null;
  modified?: string | null;
  mimeType?: string | null;
}

export interface ListingControls {
  readonly root: HTMLElement;
  readonly options: FileViewOptions;
  setCount(visible: number, total: number): void;
  setSort(sort: FileSort): void;
}

export interface ListingHeader {
  readonly root: HTMLElement;
  update(options: FileViewOptions): void;
}

const preferences = new Map<string, FileViewOptions>();
export function getListingView(context: string, tree: boolean): FileViewOptions {
  const cached = preferences.get(context);
  if (cached) return { ...cached };
  const defaults: FileViewOptions = {
    mode: 'details',
    sort: 'name',
    descending: false,
    query: '',
  };
  try {
    const value: unknown = JSON.parse(localStorage.getItem('tlbx-file-view:' + context) ?? 'null');
    if (typeof value === 'object' && value !== null) {
      const saved = value as Partial<FileViewOptions>;
      if (saved.mode === 'details' || saved.mode === 'icons' || (tree && saved.mode === 'tree'))
        defaults.mode = saved.mode;
      if (saved.sort && ['name', 'modified', 'type', 'size'].includes(saved.sort))
        defaults.sort = saved.sort;
      if (typeof saved.descending === 'boolean') defaults.descending = saved.descending;
      if (typeof saved.query === 'string') defaults.query = saved.query.slice(0, 256);
    }
  } catch {
    /* A folder remains usable without browser storage. */
  }
  preferences.set(context, defaults);
  return { ...defaults };
}

export function setListingView(context: string, options: FileViewOptions): void {
  preferences.set(context, { ...options });
  try {
    localStorage.setItem('tlbx-file-view:' + context, JSON.stringify(options));
  } catch {
    /* The current view still works. */
  }
}

export function createListingControls(
  context: string,
  allowTree: boolean,
  changed: (options: FileViewOptions) => void,
): ListingControls {
  let options = getListingView(context, allowTree);
  const root = document.createElement('div');
  root.className = 'file-listing-controls';
  root.setAttribute('role', 'search');
  root.setAttribute('aria-label', t('fileBrowser.viewOptions'));

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'file-listing-filter';
  filter.placeholder = t('fileBrowser.filterPlaceholder');
  filter.setAttribute('aria-label', t('fileBrowser.filterFiles'));
  filter.value = options.query;

  const sort = document.createElement('select');
  sort.className = 'file-listing-sort';
  sort.setAttribute('aria-label', t('fileBrowser.sortBy'));
  for (const value of ['name', 'modified', 'type', 'size'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(value === 'modified' ? 'fileViewer.modified' : `fileBrowser.${value}`);
    sort.append(option);
  }

  const direction = document.createElement('button');
  direction.type = 'button';
  direction.className = 'file-listing-direction';

  const views = document.createElement('div');
  views.className = 'file-listing-views';
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', t('fileBrowser.viewMode'));
  const modes: FileViewMode[] = allowTree ? ['tree', 'details', 'icons'] : ['details', 'icons'];
  const viewButtons = new Map<FileViewMode, HTMLButtonElement>();
  const symbols: Record<FileViewMode, string> = { tree: '☷', details: '☰', icons: '▦' };
  for (const mode of modes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = `${symbols[mode]} ${t(`fileBrowser.view${capitalize(mode)}`)}`;
    button.title = t(`fileBrowser.view${capitalize(mode)}`);
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      update({ mode });
    });
    viewButtons.set(mode, button);
    views.append(button);
  }

  const count = document.createElement('span');
  count.className = 'file-listing-count';
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');

  const update = (patch: Partial<FileViewOptions>): void => {
    options = { ...options, ...patch };
    setListingView(context, options);
    sync();
    changed({ ...options });
  };
  const sync = (): void => {
    sort.value = options.sort;
    direction.textContent = options.descending ? '↓' : '↑';
    direction.title = t(
      options.descending ? 'fileBrowser.sortDescending' : 'fileBrowser.sortAscending',
    );
    direction.setAttribute('aria-label', direction.title);
    direction.setAttribute('aria-pressed', String(options.descending));
    for (const [mode, button] of viewButtons) {
      const active = mode === options.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };

  filter.addEventListener('input', () => {
    update({ query: filter.value.slice(0, 256) });
  });
  sort.addEventListener('change', () => {
    update({ sort: sort.value as FileSort });
  });
  direction.addEventListener('click', () => {
    update({ descending: !options.descending });
  });
  const viewMenu = document.createElement('details');
  viewMenu.className = 'file-listing-options';
  const summary = document.createElement('summary');
  summary.textContent = t('fileBrowser.viewMode');
  summary.title = t('fileBrowser.viewOptions');
  summary.setAttribute('aria-label', summary.title);
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'file-listing-options-panel';
  optionsPanel.append(sort, direction, views);
  viewMenu.append(summary, optionsPanel);
  root.append(filter, viewMenu, count);
  sync();

  return {
    root,
    get options() {
      return { ...options };
    },
    setCount(visible, total) {
      count.textContent = t('fileBrowser.itemsCount')
        .replace('{visible}', String(visible))
        .replace('{total}', String(total));
    },
    setSort(nextSort) {
      update({
        sort: nextSort,
        descending: options.sort === nextSort ? !options.descending : false,
      });
    },
  };
}

export function createListingHeader(changed: (sort: FileSort) => void): ListingHeader {
  const root = document.createElement('div');
  root.className = 'file-listing-header';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('fileBrowser.sortBy'));
  const buttons = new Map<FileSort, HTMLButtonElement>();
  for (const sort of ['name', 'type', 'modified', 'size'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-listing-heading file-listing-heading-${sort}`;
    button.textContent = t(sort === 'modified' ? 'fileViewer.modified' : `fileBrowser.${sort}`);
    button.addEventListener('click', () => {
      changed(sort);
    });
    buttons.set(sort, button);
    root.append(button);
  }
  return {
    root,
    update(options) {
      root.hidden = options.mode !== 'details';
      for (const [sort, button] of buttons) {
        const active = sort === options.sort;
        button.setAttribute('aria-pressed', String(active));
        const label = t(sort === 'modified' ? 'fileViewer.modified' : `fileBrowser.${sort}`);
        button.textContent = label + (active ? (options.descending ? ' ↓' : ' ↑') : '');
        button.setAttribute(
          'aria-label',
          active
            ? `${label}: ${t(options.descending ? 'fileBrowser.sortDescending' : 'fileBrowser.sortAscending')}`
            : label,
        );
      }
    },
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function fileType(entry: ListingEntry): string {
  if (entry.isDirectory) return t('fileBrowser.folder');
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 && dot < entry.name.length - 1
    ? entry.name.slice(dot + 1).toUpperCase()
    : (entry.mimeType ?? t('fileBrowser.file'));
}

let dateFormatter: Intl.DateTimeFormat | undefined;
let dateLocale = '';
export function modifiedLabel(entry: ListingEntry): string {
  if (!entry.modified) return '—';
  const date = new Date(entry.modified);
  if (!Number.isFinite(date.getTime())) return '—';
  const locale = getCurrentLocale();
  if (!dateFormatter || dateLocale !== locale) {
    dateLocale = locale;
    dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return dateFormatter.format(date);
}

export function matchesListing(entry: ListingEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase(getCurrentLocale());
  return (
    !normalized ||
    (entry.name + ' ' + fileType(entry)).toLocaleLowerCase(getCurrentLocale()).includes(normalized)
  );
}

export function sortListing<T extends ListingEntry>(entries: T[], options: FileViewOptions): T[] {
  const collator = new Intl.Collator(getCurrentLocale(), { numeric: true, sensitivity: 'base' });
  const direction = options.descending ? -1 : 1;
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    let result = 0;
    if (options.sort === 'size' || options.sort === 'modified') {
      const a = numericField(left, options.sort),
        b = numericField(right, options.sort);
      if ((a !== null) !== (b !== null)) return a !== null ? -1 : 1;
      if (a !== null && b !== null) result = a - b;
    } else if (options.sort === 'type') result = collator.compare(fileType(left), fileType(right));
    return (
      (result || collator.compare(left.name, right.name) || left.name.localeCompare(right.name)) *
      direction
    );
  });
}

function numericField(entry: ListingEntry, sort: 'size' | 'modified'): number | null {
  const value = sort === 'size' ? entry.size : Date.parse(entry.modified ?? '');
  return value != null && Number.isFinite(value) ? value : null;
}
