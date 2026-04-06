import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPreview } from './filePreview';

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
  public readonly classList = {
    add: (...tokens: string[]) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const token of tokens) {
        values.add(token);
      }
      this.className = Array.from(values).join(' ');
    },
  };
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

  public setAttribute(_name: string, _value: string): void {}

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
const renderingMocks = vi.hoisted(() => {
  const createElement = (tagName: string) => {
    const listeners = new Map<string, Array<(event?: any) => void>>();
    const element: any = {
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      disabled: false,
      type: '',
      value: '',
      spellcheck: true,
      style: {},
      children: [] as any[],
      classList: {
        add: (...tokens: string[]) => {
          const values = new Set(String(element.className ?? '').split(/\s+/).filter(Boolean));
          for (const token of tokens) {
            values.add(token);
          }
          element.className = Array.from(values).join(' ');
        },
      },
      appendChild(child: any) {
        element.children.push(child);
        return child;
      },
      addEventListener(type: string, handler: (event?: any) => void) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(handler);
        listeners.set(type, handlers);
      },
      dispatchEvent(event: { type: string }) {
        const handlers = listeners.get(event.type) ?? [];
        for (const handler of handlers) {
          handler(event);
        }
        return true;
      },
      click() {
        element.dispatchEvent({ type: 'click' });
      },
    };
    return element;
  };

  const isTextFileMock = vi.fn(() => true);
  const createLineNumberedEditorMock = vi.fn((text: string, extraClassNames: string[] = []) => {
    const root = createElement('div');
    root.className = ['file-viewer-editor-shell', ...extraClassNames].join(' ');

    const textarea = createElement('textarea');
    textarea.className = 'file-viewer-textarea';
    textarea.value = text;
    root.appendChild(textarea);

    return {
      root,
      textarea,
      setText: (nextText: string) => {
        textarea.value = nextText;
      },
    };
  });

  const createLineNumberedViewerMock = vi.fn((text: string) => {
    const root = createElement('div');
    root.className = 'file-viewer-readonly-shell';

    const pre = createElement('pre');
    pre.className = 'file-viewer-text';
    pre.textContent = text;
    root.appendChild(pre);

    return {
      root,
      pre,
      setText: (nextText: string) => {
        pre.textContent = nextText;
      },
    };
  });

  const formatBinaryDumpMock = vi.fn((bytes: Uint8Array) => `binary:${bytes.length}`);

  return {
    isTextFileMock,
    createLineNumberedEditorMock,
    createLineNumberedViewerMock,
    formatBinaryDumpMock,
  };
});

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
  formatViewerHeaderSubtitle: (path: string, metadata?: string | null) =>
    metadata ? `${path} | ${metadata}` : path,
  highlightCode: (text: string) => `highlight:${text}`,
  isTextFile: renderingMocks.isTextFileMock,
  isImageFile: () => false,
  isVideoFile: () => false,
  isAudioFile: () => false,
  buildViewUrl: (path: string, sessionId: string) =>
    `/api/files/view?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`,
  createLineNumberedEditor: renderingMocks.createLineNumberedEditorMock,
  createLineNumberedViewer: renderingMocks.createLineNumberedViewerMock,
  formatBinaryDump: renderingMocks.formatBinaryDumpMock,
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
    renderingMocks.isTextFileMock.mockReturnValue(true);
    renderingMocks.createLineNumberedEditorMock.mockClear();
    renderingMocks.createLineNumberedViewerMock.mockClear();
    renderingMocks.formatBinaryDumpMock.mockClear();
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

  it('renders binary files through the shared line-numbered viewer', async () => {
    renderingMocks.isTextFileMock.mockReturnValue(false);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x41, 0x42]).buffer,
    } as Response);

    const container = new FakeElement('div');
    const entry = {
      name: 'archive.bin',
      fullPath: 'Q:\\repos\\MidTerm\\archive.bin',
      isDirectory: false,
      mimeType: 'application/octet-stream',
      size: 2,
    };

    renderPreview(container as unknown as HTMLElement, entry, 'session-1');
    await flushPromises();

    expect(renderingMocks.formatBinaryDumpMock).toHaveBeenCalledWith(new Uint8Array([0x41, 0x42]));
    expect(renderingMocks.createLineNumberedViewerMock).toHaveBeenCalledWith('binary:2', ['file-viewer-binary-shell']);
    expect(container.querySelector('.preview-toolbar-name')?.textContent).toBe('archive.bin');
    expect(container.querySelector('.preview-toolbar-subtitle')?.textContent).toBe(
      'Q:\\repos\\MidTerm\\archive.bin | application/octet-stream | 2',
    );
  });
});
