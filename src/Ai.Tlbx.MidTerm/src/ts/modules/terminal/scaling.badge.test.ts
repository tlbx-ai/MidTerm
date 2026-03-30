import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $isMainBrowser } from '../../stores';
import { dom, sessionTerminals } from '../../state';
import { applyTerminalScalingSync } from './scaling';
import { sendResize } from '../comms';

vi.mock('../comms', () => ({
  claimMainBrowser: vi.fn(),
  sendResize: vi.fn(),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../sidebar/voiceSection', () => ({
  isDevMode: () => false,
}));

vi.mock('../sessionTabs', () => ({
  getTabBarHeight: () => 0,
}));

vi.mock('./manager', () => ({
  focusActiveTerminal: vi.fn(),
  getCalibrationMeasurement: () => null,
  getCalibrationPromise: () => null,
}));

type FakeElement = {
  id?: string;
  className?: string;
  type?: string;
  title?: string;
  innerHTML?: string;
  parentElement?: FakeElement | null;
  style: Record<string, string>;
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
  };
  querySelector: <T>(selector: string) => T | null;
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, handler: () => void) => void;
  closest: <T>(selector: string) => T | null;
  getBoundingClientRect: () => { width: number; height: number };
  clientWidth?: number;
  clientHeight?: number;
  offsetWidth?: number;
  offsetHeight?: number;
};

function createClassList(initial: string[] = []) {
  const classes = new Set(initial);
  return {
    contains: (name: string) => classes.has(name),
    add: (name: string) => {
      classes.add(name);
    },
    remove: (name: string) => {
      classes.delete(name);
    },
  };
}

function createButtonElement(): FakeElement {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  return {
    style: {},
    classList: createClassList(),
    querySelector: () => null,
    appendChild: (child) => child,
    remove() {
      if (this.parentElement?.querySelector('.scaled-overlay') === this) {
        this.parentElement.remove();
      }
      this.parentElement = null;
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
}

function createTerminalHarness(cols: number, rows: number) {
  let overlay: FakeElement | null = null;
  const terminal = {
    cols,
    rows,
    buffer: { active: { viewportY: 0, baseY: 0 } },
    options: {},
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    }),
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: 10, height: 20 },
          },
        },
      },
    },
  };

  const xterm = {
    style: {} as Record<string, string>,
  } as FakeElement;

  Object.defineProperties(xterm, {
    offsetWidth: {
      get: () => terminal.cols * 10,
    },
    offsetHeight: {
      get: () => terminal.rows * 20,
    },
  });

  const screen = {} as FakeElement;
  Object.defineProperties(screen, {
    offsetWidth: {
      get: () => terminal.cols * 10,
    },
    offsetHeight: {
      get: () => terminal.rows * 20,
    },
  });

  const container = {
    id: 'terminal-s1',
    style: {},
    clientWidth: 818,
    clientHeight: 488,
    classList: createClassList(),
    querySelector<T>(selector: string): T | null {
      if (selector === '.xterm') return xterm as T;
      if (selector === '.xterm-screen') return screen as T;
      if (selector === '.scaled-overlay') return overlay as T;
      return null;
    },
    appendChild(child: FakeElement): FakeElement {
      overlay = child;
      child.parentElement = this;
      child.remove = () => {
        overlay = null;
        child.parentElement = null;
      };
      return child;
    },
    remove(): void {
      overlay = null;
    },
    setAttribute(): void {},
    addEventListener(): void {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 818, height: 488 }),
  } as FakeElement;

  const state = {
    terminal,
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(),
    },
    container,
    serverCols: cols,
    serverRows: rows,
    opened: true,
    pendingVisualRefresh: false,
  };

  return {
    state,
    terminal,
    xterm,
    getOverlay: () => overlay,
  };
}

describe('terminal scaling badge thresholds', () => {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    sessionTerminals.clear();
    $isMainBrowser.set(false);
    dom.terminalsArea = {
      getBoundingClientRect: () => ({ width: 818, height: 488 }),
    } as HTMLElement;
    globalThis.document = {
      createElement: () => createButtonElement(),
      getElementById: () => null,
    } as Document;
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as Storage;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    vi.mocked(sendResize).mockReset();
  });

  afterEach(() => {
    sessionTerminals.clear();
    dom.terminalsArea = null;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    vi.clearAllMocks();
  });

  it('shows the follower badge on a one-column oversized mismatch', () => {
    const harness = createTerminalHarness(82, 24);

    applyTerminalScalingSync(harness.state as never);

    expect(harness.getOverlay()?.innerHTML).toContain('terminal.scaledContent');
    expect(harness.getOverlay()?.innerHTML).toContain('terminal.makeReferenceScaleBrowser');
    expect(harness.xterm.style.transform).toContain('scale(');
  });

  it('shows the follower badge on a one-column undersized mismatch', () => {
    const harness = createTerminalHarness(80, 24);

    applyTerminalScalingSync(harness.state as never);

    expect(harness.getOverlay()?.innerHTML).toContain('terminal.sizedForSmallerScreen');
    expect(harness.getOverlay()?.innerHTML).toContain('terminal.makeReferenceScaleBrowser');
    expect(harness.xterm.style.transform ?? '').toBe('');
  });

  it('shows the follower claim badge even when the terminal already fits', () => {
    const harness = createTerminalHarness(81, 24);

    applyTerminalScalingSync(harness.state as never);

    expect(harness.getOverlay()?.innerHTML).toContain('terminal.makeReferenceScaleBrowser');
    expect(harness.xterm.style.transform ?? '').toBe('');
  });

  it('resizes immediately after the browser becomes main and clears the badge path', () => {
    const harness = createTerminalHarness(80, 24);
    sessionTerminals.set('s1', harness.state as never);
    $isMainBrowser.set(true);

    applyTerminalScalingSync(harness.state as never);

    expect(harness.terminal.resize).toHaveBeenCalledWith(81, 24);
    expect(sendResize).toHaveBeenCalledWith('s1', 81, 24);
    expect(harness.getOverlay()).toBeNull();
  });
});
