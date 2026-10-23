import { reconcileKeyedChildren } from '../../utils/domReconcile';
import type { BoardEntry, BoardItem } from './boardApi';
import { t } from '../i18n';
import { mountBoardBrowser } from './boardBrowser';

const itemContext = new WeakMap<HTMLElement, BoardItem>();
const entryContext = new WeakMap<HTMLElement, { entry: BoardEntry; item: BoardItem }>();

export interface BoardItemActions {
  changed: (item: BoardItem) => void;
  remove: (item: BoardItem) => void;
  launch: (item: BoardItem) => void;
  settings: (item: BoardItem) => void;
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Board element is no longer available.');
  return value;
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function patchInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

export function renderBoardItems(
  plane: HTMLElement,
  items: BoardItem[],
  boardId: string,
  actions: BoardItemActions,
): void {
  reconcileKeyedChildren(plane, items, {
    key: (item) => item.id,
    create: (item) => createItem(item, actions),
    patch: (element, item) => {
      patchItem(element, item, boardId, actions);
    },
  });
}

function createItem(item: BoardItem, actions: BoardItemActions): HTMLElement {
  const tile = document.createElement('article');
  tile.className = 'board-item';
  tile.dataset.id = item.id;
  const header = document.createElement('header');
  header.className = 'board-item-grip';
  const kind = document.createElement('span');
  kind.className = 'board-item-kind';
  header.append(kind);
  header.append(
    button('▶', () => {
      actions.launch(required(itemContext.get(tile)));
    }),
    button('⋯', () => {
      actions.settings(required(itemContext.get(tile)));
    }),
    button('×', () => {
      actions.remove(required(itemContext.get(tile)));
    }),
  );
  header.querySelectorAll('button').forEach((element, index) => {
    element.title = t(
      ['boards.launch', 'boards.itemSettings', 'boards.deleteItem'][index] ?? 'boards.itemSettings',
    );
    element.setAttribute('aria-label', element.title);
    element.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
  });
  const title = document.createElement('input');
  title.className = 'board-item-title';
  title.placeholder = t('boards.titlePlaceholder');
  title.setAttribute('aria-label', t('boards.itemTitle'));
  title.maxLength = 256;
  title.addEventListener('input', () => {
    const current = required(itemContext.get(tile));
    current.title = title.value;
    actions.changed(current);
  });
  const text = document.createElement('textarea');
  text.className = 'board-item-text';
  text.placeholder = t('boards.notePlaceholder');
  text.setAttribute('aria-label', t('boards.noteText'));
  text.addEventListener('input', () => {
    const current = required(itemContext.get(tile));
    current.text = text.value;
    actions.changed(current);
  });
  const entries = document.createElement('div');
  entries.className = 'board-entry-list';
  const add = document.createElement('input');
  add.className = 'board-entry-add';
  add.placeholder = t('boards.addEntry');
  add.setAttribute('aria-label', t('boards.addEntry'));
  add.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !add.value.trim()) return;
    const current = required(itemContext.get(tile));
    current.entries.push({ id: crypto.randomUUID(), text: add.value.trim(), done: false });
    add.value = '';
    actions.changed(current);
    patchEntries(entries, current, actions);
  });
  const frame = document.createElement('iframe');
  frame.className = 'board-browser-frame';
  frame.title = t('boards.browser');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  const resize = document.createElement('div');
  resize.className = 'board-resize';
  resize.setAttribute('aria-hidden', 'true');
  tile.append(header, title, text, entries, add, frame, resize);
  return tile;
}

function patchItem(
  tile: HTMLElement,
  item: BoardItem,
  boardId: string,
  actions: BoardItemActions,
): void {
  itemContext.set(tile, item);
  tile.dataset.kind = item.kind;
  tile.dataset.color = item.color;
  tile.style.transform = `translate(${item.x}px, ${item.y}px)`;
  tile.style.width = `${item.width}px`;
  tile.style.height = `${item.height}px`;
  tile.style.zIndex = String(item.z);
  required(tile.querySelector<HTMLElement>('.board-item-kind')).textContent = t(
    `boards.${item.kind}`,
  );
  patchInput(required(tile.querySelector<HTMLInputElement>('.board-item-title')), item.title);
  patchInput(required(tile.querySelector<HTMLTextAreaElement>('.board-item-text')), item.text);
  patchEntries(required(tile.querySelector<HTMLElement>('.board-entry-list')), item, actions);
  const frame = required(tile.querySelector<HTMLIFrameElement>('iframe'));
  if (item.kind === 'browser') void mountBoardBrowser(frame, boardId, item);
}

function patchEntries(parent: HTMLElement, item: BoardItem, actions: BoardItemActions): void {
  reconcileKeyedChildren(parent, item.entries, {
    key: (entry) => entry.id,
    create: () => {
      const row = document.createElement('div');
      row.className = 'board-entry';
      const done = document.createElement('input');
      done.type = 'checkbox';
      done.setAttribute('aria-label', t('boards.done'));
      const text = document.createElement('input');
      text.className = 'board-entry-text';
      text.setAttribute('aria-label', t('boards.entryText'));
      const date = document.createElement('input');
      date.type = 'date';
      date.className = 'board-entry-date';
      date.setAttribute('aria-label', t('boards.date'));
      const period = document.createElement('input');
      period.className = 'board-entry-period';
      period.placeholder = '2027 W12 / Q1';
      period.setAttribute('aria-label', t('boards.period'));
      done.addEventListener('change', () => {
        required(entryContext.get(row)).entry.done = done.checked;
        actions.changed(required(entryContext.get(row)).item);
      });
      text.addEventListener('input', () => {
        required(entryContext.get(row)).entry.text = text.value;
        actions.changed(required(entryContext.get(row)).item);
      });
      date.addEventListener('change', () => {
        required(entryContext.get(row)).entry.date = date.value || null;
        actions.changed(required(entryContext.get(row)).item);
      });
      period.addEventListener('change', () => {
        const entry = required(entryContext.get(row)).entry;
        const match = /^(\d{4})\s+(?:W(\d{1,2})|Q([1-4]))$/i.exec(period.value.trim());
        if (!match && period.value.trim()) {
          period.setCustomValidity(t('boards.invalidPeriod'));
          period.reportValidity();
          return;
        }
        period.setCustomValidity('');
        entry.year = match ? Number(match[1]) : null;
        entry.week = match?.[2] ? Number(match[2]) : null;
        entry.quarter = match?.[3] ? Number(match[3]) : null;
        actions.changed(required(entryContext.get(row)).item);
      });
      const remove = button('×', () => {
        const entry = required(entryContext.get(row)).entry;
        const current = required(entryContext.get(row)).item;
        current.entries = current.entries.filter((candidate) => candidate.id !== entry.id);
        actions.changed(required(entryContext.get(row)).item);
        patchEntries(parent, required(entryContext.get(row)).item, actions);
      });
      remove.setAttribute('aria-label', t('boards.deleteEntry'));
      row.append(done, text, date, period, remove);
      return row;
    },
    patch: (row, entry) => {
      entryContext.set(row, { entry, item });
      const inputs = row.querySelectorAll('input');
      required(inputs[0]).checked = entry.done;
      patchInput(required(inputs[1]), entry.text);
      patchInput(required(inputs[2]), entry.date ?? '');
      patchInput(
        required(inputs[3]),
        entry.year
          ? `${entry.year} ${entry.week ? `W${entry.week}` : `Q${entry.quarter ?? 1}`}`
          : '',
      );
      row.classList.toggle('is-done', entry.done);
    },
  });
}
