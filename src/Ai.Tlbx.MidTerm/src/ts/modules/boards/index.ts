import { boardRequest, newBoardItem, type BoardDocument, type BoardItem } from './boardApi';
import { bindBoardCanvas } from './boardCanvas';
import { renderBoardItems } from './boardItems';
import { t } from '../i18n';
import { showConfirm } from '../../utils/dialog';

let view: BoardView | null = null;

export function initBoards(): void {
  document.getElementById('btn-boards')?.addEventListener('click', () => {
    view ??= new BoardView();
    void view.open();
  });
}

export async function initDetachedBoard(): Promise<boolean> {
  const id = new URLSearchParams(location.search).get('board');
  if (!id) return false;
  view = new BoardView(true);
  await view.open(id);
  return true;
}

class BoardView {
  private readonly root = document.createElement('section');
  private readonly surface = document.createElement('div');
  private readonly plane = document.createElement('div');
  private readonly picker = document.createElement('select');
  private readonly title = document.createElement('input');
  private readonly status = document.createElement('span');
  private readonly zoom = document.createElement('button');
  private readonly inspector = document.createElement('aside');
  private board: BoardDocument | null = null;
  private canvas: ReturnType<typeof bindBoardCanvas> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirty = new Map<string, number>();
  private viewportDirty = 0;
  private saving = false;
  private selected: string | null = null;
  private generation = 0;

  constructor(private readonly detached = false) {
    this.root.className = 'boards-workspace';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', t('boards.title'));
    this.root.setAttribute('aria-modal', 'true');
    this.root.hidden = true;
    const header = document.createElement('header');
    header.className = 'boards-header';
    const brand = document.createElement('strong');
    brand.textContent = t('boards.title');
    this.picker.setAttribute('aria-label', t('boards.chooseBoard'));
    this.picker.addEventListener('change', () => {
      void this.open(this.picker.value);
    });
    this.title.className = 'boards-title';
    this.title.setAttribute('aria-label', t('boards.boardTitle'));
    this.title.maxLength = 256;
    this.title.addEventListener('change', () => {
      if (this.board && this.title.value.trim()) {
        this.board.title = this.title.value;
        this.markViewport();
      }
    });
    this.status.className = 'boards-save-state';
    this.status.setAttribute('role', 'status');
    header.append(
      brand,
      this.picker,
      this.title,
      this.status,
      this.button(t('boards.newBoard'), () => {
        void this.createBoard();
      }),
      this.button(t('boards.detach'), () => {
        if (this.board)
          window.open(
            `/?board=${encodeURIComponent(this.board.id)}`,
            '_blank',
            'popup,width=1400,height=900',
          );
      }),
      this.button(t('boards.close'), () => {
        void this.close();
      }),
    );
    const tools = document.createElement('nav');
    tools.className = 'boards-tools';
    tools.setAttribute('aria-label', t('boards.tools'));
    const kinds: BoardItem['kind'][] = ['note', 'todo', 'calendar', 'mail', 'timeline', 'browser'];
    for (const kind of kinds) {
      const tool = this.button(t(`boards.${kind}`), () => {
        void this.add(kind);
      });
      tool.dataset.kind = kind;
      tools.append(tool);
    }
    this.zoom.type = 'button';
    this.zoom.title = t('boards.resetView');
    this.zoom.addEventListener('click', () => {
      if (!this.board) return;
      this.board.zoom = 1;
      this.board.panX = 80;
      this.board.panY = 80;
      this.canvas?.render();
      this.markViewport();
    });
    tools.append(this.zoom);
    this.surface.className = 'boards-surface';
    this.plane.className = 'boards-plane';
    this.surface.append(this.plane);
    this.surface.addEventListener('boardzoom', () => {
      this.zoom.textContent = `${Math.round((this.board?.zoom ?? 1) * 100)}%`;
    });
    this.inspector.className = 'boards-inspector';
    this.inspector.hidden = true;
    const hint = document.createElement('div');
    hint.className = 'boards-hint';
    hint.textContent = t('boards.canvasHint');
    this.root.append(header, this.surface, tools, this.inspector, hint);
    document.body.append(this.root);
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.selected) this.select(null);
        else void this.close();
        event.stopPropagation();
      }
    });
  }

  async open(id?: string): Promise<void> {
    if (this.board && (this.dirty.size || this.viewportDirty)) {
      await this.flush();
      if (this.dirty.size || this.viewportDirty) return;
    }
    this.root.hidden = false;
    try {
      const boards = await boardRequest<BoardDocument[]>();
      this.picker.replaceChildren(
        ...boards.map((board) => {
          const option = document.createElement('option');
          option.value = board.id;
          option.textContent = board.title;
          return option;
        }),
      );
      const next = id ?? this.board?.id ?? boards[0]?.id;
      if (!next) {
        await this.createBoard();
        return;
      }
      const board = await boardRequest<BoardDocument>(`/${next}`);
      this.canvas?.dispose();
      this.board = board;
      this.selected = null;
      this.inspector.hidden = true;
      this.title.value = board.title;
      this.picker.value = board.id;
      this.canvas = bindBoardCanvas(this.surface, this.plane, board, {
        viewportChanged: () => {
          this.markViewport();
        },
        itemChanged: (item) => {
          this.markItem(item);
        },
        createNote: (x, y) => {
          void this.add('note', x, y);
        },
        selected: (itemId) => {
          this.select(itemId);
        },
      });
      this.render();
      if (!this.poll)
        this.poll = setInterval(() => {
          void this.refresh();
        }, 2000);
      this.title.focus();
    } catch (error) {
      this.error(error);
    }
  }

  private async createBoard(): Promise<void> {
    try {
      const board = await boardRequest<BoardDocument>('', 'POST', {
        title: t('boards.untitled'),
        panX: 80,
        panY: 80,
      });
      await this.open(board.id);
      this.title.select();
    } catch (error) {
      this.error(error);
    }
  }

  private async add(kind: BoardItem['kind'], x?: number, y?: number): Promise<void> {
    if (!this.board) return;
    const board = this.board;
    const item = newBoardItem(
      kind,
      x ?? (this.surface.clientWidth / 2 - board.panX) / board.zoom - 160,
      y ?? (this.surface.clientHeight / 2 - board.panY) / board.zoom - 100,
    );
    item.z = Math.max(0, ...board.items.map((entry) => entry.z)) + 1;
    try {
      const created = await boardRequest<BoardItem>(`/${board.id}/items`, 'POST', { item });
      if (this.board !== board) return;
      board.items.push(created);
      this.render();
      this.select(created.id);
      this.plane
        .querySelector<HTMLInputElement | HTMLTextAreaElement>(
          `[data-id="${created.id}"] ${kind === 'note' ? '.board-item-text' : '.board-item-title'}`,
        )
        ?.focus();
    } catch (error) {
      this.error(error);
    }
  }

  private render(): void {
    if (!this.board) return;
    renderBoardItems(this.plane, this.board.items, this.board.id, {
      changed: (item) => {
        this.markItem(item);
      },
      remove: (item) => {
        void this.remove(item);
      },
      launch: (item) => {
        this.select(item.id, true);
        this.inspector.querySelector<HTMLInputElement>('[name="launchCommand"]')?.focus();
      },
      settings: (item) => {
        this.select(item.id, true);
      },
    });
  }

  private select(id: string | null, inspect = false): void {
    if (this.selected === id && !inspect) return;
    this.selected = id;
    for (const tile of this.plane.querySelectorAll<HTMLElement>('.board-item'))
      tile.classList.toggle('is-selected', tile.dataset.id === id);
    const item = this.board?.items.find((entry) => entry.id === id);
    this.inspector.hidden = !item || !inspect;
    if (!item || !inspect) return;
    this.renderInspector(item);
  }

  private renderInspector(item: BoardItem): void {
    this.inspector.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = t('boards.itemSettings');
    this.inspector.append(
      heading,
      this.button('×', () => {
        this.select(null);
      }),
    );
    const fields = [
      'url',
      'localDirectory',
      'workingDirectory',
      'launchCommand',
      'prompt',
    ] as const;
    for (const field of fields) {
      if ((field === 'url' || field === 'localDirectory') && item.kind !== 'browser') continue;
      const label = document.createElement('label');
      label.textContent = t(`boards.${field}`);
      const input =
        field === 'prompt' ? document.createElement('textarea') : document.createElement('input');
      input.name = field;
      input.value = item[field] ?? '';
      input.addEventListener('change', () => {
        item[field] = input.value || null;
        this.markItem(item);
        this.render();
      });
      label.append(input);
      this.inspector.append(label);
    }
    const palette = document.createElement('div');
    palette.className = 'boards-palette';
    for (const color of ['sand', 'rose', 'sage', 'blue', 'plain']) {
      const swatch = this.button('', () => {
        item.color = color;
        this.markItem(item);
        this.render();
      });
      swatch.dataset.color = color;
      swatch.title = t(`boards.color.${color}`);
      swatch.setAttribute('aria-label', swatch.title);
      palette.append(swatch);
    }
    this.inspector.append(palette);
  }

  private async remove(item: BoardItem): Promise<void> {
    if (!this.board || !(await showConfirm(t('boards.confirmDelete')))) return;
    await this.flush();
    if (this.dirty.has(item.id)) return;
    try {
      await boardRequest(
        `/${this.board.id}/items/${item.id}?expectedRevision=${item.revision}`,
        'DELETE',
      );
      this.board.items = this.board.items.filter((entry) => entry.id !== item.id);
      this.select(null);
      this.render();
    } catch (error) {
      this.error(error);
    }
  }

  private markItem(item: BoardItem): void {
    this.dirty.set(item.id, ++this.generation);
    this.schedule();
  }

  private markViewport(): void {
    this.viewportDirty = ++this.generation;
    this.schedule();
  }

  private schedule(): void {
    this.status.textContent = t('boards.saving');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, 450);
  }

  private async flush(): Promise<void> {
    if (this.saving || !this.board) return;
    this.saving = true;
    const board = this.board;
    try {
      for (const [id, generation] of this.dirty) {
        const item = board.items.find((entry) => entry.id === id);
        if (!item) {
          this.dirty.delete(id);
          continue;
        }
        const saved = await boardRequest<BoardItem>(`/${board.id}/items/${id}`, 'PUT', {
          expectedRevision: item.revision,
          item,
        });
        item.revision = saved.revision;
        if (this.dirty.get(id) === generation) this.dirty.delete(id);
      }
      if (this.viewportDirty) {
        const generation = this.viewportDirty;
        const saved = await boardRequest<BoardDocument>(`/${board.id}`, 'PATCH', {
          expectedRevision: board.revision,
          title: board.title,
          panX: board.panX,
          panY: board.panY,
          zoom: board.zoom,
        });
        board.revision = saved.revision;
        if (this.viewportDirty === generation) this.viewportDirty = 0;
      }
      this.status.textContent = t('boards.saved');
      if (this.dirty.size || this.viewportDirty) this.schedule();
    } catch (error) {
      this.error(error);
    } finally {
      this.saving = false;
    }
  }

  private async refresh(): Promise<void> {
    if (
      !this.board ||
      this.root.hidden ||
      this.saving ||
      this.dirty.size ||
      this.viewportDirty ||
      this.surface.classList.contains('is-dragging')
    )
      return;
    const board = this.board;
    try {
      const fresh = await boardRequest<BoardDocument>(`/${board.id}`);
      if (!this.canApplyRefresh(board)) return;
      const existing = new Map(board.items.map((item) => [item.id, item]));
      const items = fresh.items.map((item) => {
        const previous = existing.get(item.id);
        return previous ? Object.assign(previous, item) : item;
      });
      board.items = items;
      if (fresh.revision !== board.revision) {
        Object.assign(board, { ...fresh, items });
        if (document.activeElement !== this.title) this.title.value = board.title;
        this.canvas?.render();
      }
      this.render();
    } catch (error) {
      this.error(error);
    }
  }

  private async close(): Promise<void> {
    await this.flush();
    if (this.saving || this.dirty.size || this.viewportDirty) return;
    if (this.detached) {
      window.close();
      return;
    }
    this.root.hidden = true;
    this.canvas?.dispose();
    this.canvas = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    document.getElementById('btn-boards')?.focus();
  }

  private canApplyRefresh(board: BoardDocument): boolean {
    return (
      this.board === board &&
      !this.saving &&
      !this.dirty.size &&
      !this.viewportDirty &&
      !this.inspector.contains(document.activeElement)
    );
  }

  private error(error: unknown): void {
    this.status.textContent = `${t('boards.saveError')} ${error instanceof Error ? error.message : String(error)}`;
    this.status.title = this.status.textContent;
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  }
}
