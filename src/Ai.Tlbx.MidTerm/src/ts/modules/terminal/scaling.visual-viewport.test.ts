import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $currentSettings, $isMainBrowser } from '../../stores';
import { dom, sessionTerminals } from '../../state';
import { setupVisualViewport } from './scaling';
import { sendResize } from '../comms';

const mocks = vi.hoisted(() => ({
  refreshTerminalRenderer: vi.fn((state: any) => {
    const dims = state.terminal?._core?._renderService?.dimensions?.css?.cell;
    if (dims) {
      dims.width = 10;
      dims.height = 20;
    }
  }),
}));

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

vi.mock('./presentationRefresh', () => ({
  isTerminalVisible: () => true,
  refreshTerminalRenderer: mocks.refreshTerminalRenderer,
}));

function createHarness() {
  const terminal = {
    cols: 82,
    rows: 24,
    buffer: { active: { viewportY: 0, baseY: 0 } },
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    }),
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: 9.5, height: 20 },
          },
        },
      },
    },
  };

  const xterm = { style: {} as Record<string, string> };
  Object.defineProperties(xterm, {
    offsetWidth: {
      get: () => terminal.cols * 10,
    },
    offsetHeight: {
      get: () => terminal.rows * 20,
    },
  });

  const screen = {};
  Object.defineProperties(screen, {
    offsetWidth: {
      get: () => terminal.cols * 10,
    },
    offsetHeight: {
      get: () => terminal.rows * 20,
    },
  });

  const container = {
    style: {},
    clientWidth: 818,
    clientHeight: 488,
    classList: {
      contains: () => false,
      add: vi.fn(),
      remove: vi.fn(),
    },
    closest: () => null,
    querySelector<T>(selector: string): T | null {
      if (selector === '.xterm') return xterm as T;
      if (selector === '.xterm-screen') return screen as T;
      return null;
    },
    getBoundingClientRect: () => ({ width: 818, height: 488 }),
  };

  return {
    state: {
      terminal,
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: vi.fn(),
      },
      container,
      serverCols: 82,
      serverRows: 24,
      opened: true,
      pendingVisualRefresh: false,
    },
  };
}

describe('setupVisualViewport', () => {
  const host = globalThis as typeof globalThis & {
    window?: typeof globalThis;
    visualViewport?: unknown;
    innerHeight: number;
    scrollTo: typeof globalThis.scrollTo;
  };
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = host.window;
  const originalVisualViewport = host.visualViewport;
  const originalInnerHeight = host.innerHeight;
  const originalScrollTo = host.scrollTo;

  beforeEach(() => {
    sessionTerminals.clear();
    vi.mocked(sendResize).mockReset();
    mocks.refreshTerminalRenderer.mockClear();
    $isMainBrowser.set(true);
    $currentSettings.set({
      fontSize: 14,
      fontFamily: 'Cascadia Code',
    } as never);

    const harness = createHarness();
    sessionTerminals.set('s1', harness.state as never);
    dom.terminalsArea = {
      getBoundingClientRect: () => ({ width: 818, height: 488 }),
    } as HTMLElement;

    globalThis.document = {
      querySelector: () => null,
      documentElement: { style: {} },
      body: {
        style: {},
        classList: {
          contains: () => false,
          toggle: vi.fn(),
        },
      },
      getElementById: () => null,
    } as unknown as Document;

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as Storage;

    Object.defineProperty(host, 'window', {
      configurable: true,
      value: host,
    });
    Object.defineProperty(host, 'innerHeight', {
      configurable: true,
      value: 700,
    });
    Object.defineProperty(host, 'visualViewport', {
      configurable: true,
      value: {
        height: 600,
        offsetTop: 0,
        addEventListener: vi.fn(),
      },
    });
    host.scrollTo = vi.fn();
  });

  afterEach(() => {
    sessionTerminals.clear();
    dom.terminalsArea = null;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    Object.defineProperty(host, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(host, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
    Object.defineProperty(host, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
    host.scrollTo = originalScrollTo;
    vi.clearAllMocks();
  });

  it('makes the leading browser resize terminals on visual viewport changes', () => {
    setupVisualViewport();

    expect(sendResize).toHaveBeenCalledWith('s1', 81, 24);
  });
});
