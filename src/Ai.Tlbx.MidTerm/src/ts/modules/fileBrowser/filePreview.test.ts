import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeElement {
  public readonly tagName: string;
  public className = '';
  public textContent = '';
  public disabled = false;
  public type = '';
  public value = '';
  public spellcheck = true;
  public readonly style: Record<string, string> = {};
  public children: FakeElement[] = [];
  private _innerHTML = '';
  private readonly listeners = new Map<string, Array<(event?: any) => void>>();

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public set innerHTML(value: string) {
    this._innerHTML = value;
    this.children = [];
  }

  public get innerHTML(): string {
    return this._innerHTML;
  }

  public appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  public addEventListener(type: string, handler: (event?: any) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  public dispatchEvent(event: { type: string }): boolean {
    const handlers = this.listeners.get(event.type) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
    return true;
  }

  public click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  public querySelector(selector: string): FakeElement | null {
    return findMatchingElement(this.children, selector);
  }
}

function findMatchingElement(elements: FakeElement[], selector: string): FakeElement | null {
  for (const element of elements) {
    if (matchesSelector(element, selector)) {
      return element;
    }

    const nested = findMatchingElement(element.children, selector);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith('.')) {
    const className = selector.slice(1);
    return element.className.split(/\s+/).includes(className);
  }

  return element.tagName.toLowerCase() === selector.toLowerCase();
}

const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../fileViewer/rendering', () => ({
  formatSize: (size: number) => `${size}`,
  getExtension: (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase(),
  highlightCode: (text: string) => `highlight:${text}`,
  renderMarkdown: (text: string) => `markdown:${text}`,
  isTextFile: () => true,
  isImageFile: () => false,
  isVideoFile: () => false,
  isAudioFile: () => false,
  buildViewUrl: (path: string, sessionId: string) =>
    `/api/files/view?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`,
  getFileIcon: () => 'file',
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('filePreview', () => {
  beforeAll(() => {
    Object.assign(globalThis, {
      document: {
        createElement: (tagName: string) => new FakeElement(tagName),
      },
    });
  });

  afterAll(() => {
    Object.assign(globalThis, {
      document: originalDocument,
      fetch: originalFetch,
    });
  });

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it('opens markdown files in editor mode with a save button', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => '# Title',
    } as Response);

    const container = new FakeElement('div');
    const entry = {
      name: 'README.md',
      fullPath: 'Q:\\repos\\MidTerm\\README.md',
      isDirectory: false,
    };

    const { renderPreview } = await import('./filePreview');
    renderPreview(container as unknown as HTMLElement, entry, 'session-1');
    await flushPromises();

    const textarea = container.querySelector('textarea');
    const saveBtn = container.querySelector('.preview-save-btn');
    const editBtn = container.querySelector('.preview-editor-btn');

    expect(textarea).not.toBeNull();
    expect(saveBtn?.style.display).toBe('');
    expect(saveBtn?.disabled).toBe(true);
    expect(editBtn?.style.display).toBe('none');
  });

  it('saves edited markdown content through the file save endpoint', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '# Title',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '',
      } as Response);

    const container = new FakeElement('div');
    const entry = {
      name: 'README.md',
      fullPath: 'Q:\\repos\\MidTerm\\README.md',
      isDirectory: false,
    };

    const { renderPreview } = await import('./filePreview');
    renderPreview(container as unknown as HTMLElement, entry, 'session-1');
    await flushPromises();

    const textarea = container.querySelector('textarea');
    const saveBtn = container.querySelector('.preview-save-btn');

    expect(textarea).not.toBeNull();
    expect(saveBtn).not.toBeNull();

    textarea!.value = '# Updated';
    textarea!.dispatchEvent({ type: 'input' });
    expect(saveBtn!.disabled).toBe(false);

    saveBtn!.click();
    await flushPromises();

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      '/api/files/save?sessionId=session-1',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'Q:\\repos\\MidTerm\\README.md',
          content: '# Updated',
        }),
      }),
    );
    expect(saveBtn!.disabled).toBe(true);
  });
});
