import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(next: T) => void>();

  return {
    get(): T {
      return value;
    },
    set(next: T): void {
      value = next;
      listeners.forEach((listener) => listener(next));
    },
    subscribe(listener: (next: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

class ElementMock {
  public readonly children: ElementMock[] = [];
  public readonly style: { cssText: string } = { cssText: '' };
  public readonly attributes = new Map<string, string>();
  public readonly classList = {
    add: (...tokens: string[]) => {
      tokens.forEach((token) => this.classNames.add(token));
      this.syncClassName();
    },
    remove: (...tokens: string[]) => {
      tokens.forEach((token) => this.classNames.delete(token));
      this.syncClassName();
    },
    contains: (token: string) => this.classNames.has(token),
  };

  public textContent = '';
  public innerHTML = '';
  public name = '';
  public content = '';
  public rel = '';
  public href = '';
  public tagName: string;

  private readonly classNames = new Set<string>();
  private _className = '';

  public constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public get className(): string {
    return this._className;
  }

  public set className(value: string) {
    this.classNames.clear();
    value
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0)
      .forEach((token) => this.classNames.add(token));
    this.syncClassName();
  }

  public get offsetWidth(): number {
    return 100;
  }

  public appendChild(child: ElementMock): ElementMock {
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'name') {
      this.name = value;
    }
    if (name === 'content') {
      this.content = value;
    }
    if (name === 'rel') {
      this.rel = value;
    }
    if (name === 'href') {
      this.href = value;
    }
  }

  public querySelector<T extends ElementMock>(selector: string): T | null {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        return child as T;
      }

      const nested = child.querySelector<T>(selector);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  private syncClassName(): void {
    this._className = Array.from(this.classNames).join(' ');
  }
}

class DocumentMock {
  public readonly head = new ElementMock('head');
  public readonly body = new ElementMock('body');
  public readonly documentElement = new ElementMock('html');

  public createElement(tagName: string): ElementMock {
    return new ElementMock(tagName);
  }

  public querySelector<T extends ElementMock>(selector: string): T | null {
    return this.head.querySelector<T>(selector) ?? this.body.querySelector<T>(selector);
  }
}

function matchesSelector(element: ElementMock, selector: string): boolean {
  if (selector.startsWith('.')) {
    return element.classList.contains(selector.slice(1));
  }

  if (selector === 'meta[name="theme-color"]') {
    return element.tagName === 'META' && element.name === 'theme-color';
  }

  return false;
}

const activeSessionStore = createStore<string | null>(null);
const sessionListStore = createStore<any[]>([]);
const sessionTerminals = new Map<string, any>();
const getSessionHeatMock = vi.fn<(sessionId: string) => number>();
const getDisplayedSessionHeatMock = vi.fn<(sessionId: string) => number>();

vi.mock('../../state', () => ({
  sessionTerminals,
}));

vi.mock('../../stores', () => ({
  $activeSessionId: activeSessionStore,
  $sessionList: sessionListStore,
}));

vi.mock('../sidebar/heatIndicator', () => ({
  getSessionHeat: getSessionHeatMock,
  getDisplayedSessionHeat: getDisplayedSessionHeatMock,
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

describe('mobilePiP heat tracking', () => {
  let documentListeners: Record<string, Listener[]>;
  let intervalCallbacks: Array<() => void>;
  let timeoutCallbacks: Array<() => void>;
  let pipDocument: DocumentMock;

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function triggerDocumentEvent(event: string): void {
    (documentListeners[event] ?? []).forEach((listener) => listener());
  }

  function runIntervals(): void {
    intervalCallbacks.forEach((callback) => callback());
  }

  function getRateElement(): ElementMock {
    const rate = pipDocument.querySelector<ElementMock>('.mm-mobile-pip__rate');
    if (!rate) {
      throw new Error('missing PiP rate element');
    }

    return rate;
  }

  function getRootElement(): ElementMock {
    const root = pipDocument.querySelector<ElementMock>('.mm-mobile-pip');
    if (!root) {
      throw new Error('missing PiP root element');
    }

    return root;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();

    documentListeners = {};
    intervalCallbacks = [];
    timeoutCallbacks = [];
    pipDocument = new DocumentMock();

    activeSessionStore.set('session-a');
    sessionListStore.set([{ id: 'session-a', name: 'Session A' }, { id: 'session-b', name: 'Session B' }]);
    sessionTerminals.clear();
    sessionTerminals.set('session-a', {
      terminal: {
        rows: 24,
        buffer: {
          active: {
            baseY: 0,
            getLine: () => ({
              translateToString: () => '$ echo ready',
            }),
          },
        },
      },
    });
    sessionTerminals.set('session-b', {
      terminal: {
        rows: 24,
        buffer: {
          active: {
            baseY: 0,
            getLine: () => ({
              translateToString: () => '$ idle',
            }),
          },
        },
      },
    });

    let liveHeat = 0;
    let displayedHeat = 0;
    getSessionHeatMock.mockImplementation((sessionId: string) => (sessionId === 'session-a' ? liveHeat : 0));
    getDisplayedSessionHeatMock.mockImplementation((sessionId: string) =>
      sessionId === 'session-a' ? displayedHeat : 0,
    );

    vi.stubGlobal('navigator', {
      maxTouchPoints: 1,
    });

    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => '#111111',
    }));

    const visibilityDocument = {
      hidden: false,
      visibilityState: 'visible',
      documentElement: { style: { cssText: '--bg-primary:#111111;' } },
      addEventListener: vi.fn((event: string, listener: Listener) => {
        (documentListeners[event] ??= []).push(listener);
      }),
    };

    vi.stubGlobal('document', visibilityDocument);

    const pipWindow = {
      closed: false,
      document: pipDocument,
      addEventListener: vi.fn(),
      close: vi.fn(function (this: { closed: boolean }) {
        this.closed = true;
      }),
    };

    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
      })),
      addEventListener: vi.fn(),
      setInterval: vi.fn((callback: () => void) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      }),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        timeoutCallbacks.push(callback);
        return timeoutCallbacks.length;
      }),
      clearTimeout: vi.fn(),
      documentPictureInPicture: {
        window: null,
        requestWindow: vi.fn(async () => pipWindow),
      },
    });

    Object.defineProperty(globalThis, '__setHeatState', {
      value: (nextLiveHeat: number, nextDisplayedHeat: number) => {
        liveHeat = nextLiveHeat;
        displayedHeat = nextDisplayedHeat;
      },
      configurable: true,
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__setHeatState;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses server heat transitions for PiP status and cooldown flashing', async () => {
    const module = await import('./mobilePiP');
    module.initMobilePiP();

    (document as { visibilityState: string }).visibilityState = 'hidden';
    (document as { hidden: boolean }).hidden = true;
    triggerDocumentEvent('visibilitychange');
    await flushPromises();

    expect(getRateElement().textContent).toBe('. idle');
    expect(getRootElement().classList.contains('heat-idle')).toBe(true);

    (globalThis as Record<string, (liveHeat: number, displayedHeat: number) => void>).__setHeatState(
      1,
      1,
    );
    runIntervals();

    expect(getRateElement().textContent).toBe('^ live');
    expect(getRootElement().classList.contains('heat-up')).toBe(true);

    (globalThis as Record<string, (liveHeat: number, displayedHeat: number) => void>).__setHeatState(
      0,
      0.6,
    );
    runIntervals();

    expect(getRateElement().textContent).toBe('v cooling');
    expect(getRootElement().classList.contains('heat-down')).toBe(true);
    expect(getRootElement().classList.contains('cooling-flash')).toBe(true);

    activeSessionStore.set('session-b');

    expect(getRateElement().textContent).toBe('. idle');
    expect(getRootElement().classList.contains('heat-idle')).toBe(true);
  });
});
