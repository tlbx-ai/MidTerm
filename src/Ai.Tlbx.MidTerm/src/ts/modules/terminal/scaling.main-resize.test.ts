import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $currentSettings, $isMainBrowser } from '../../stores';
import { dom, sessionTerminals } from '../../state';
import { fitSessionToScreen } from './scaling';
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

type FakeElement = {
  style: Record<string, string>;
  classList: {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
  };
  querySelector: <T>(selector: string) => T | null;
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

function createFitHarness() {
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
    style: {},
    clientWidth: 818,
    clientHeight: 488,
    classList: createClassList(),
    closest: () => null,
    querySelector<T>(selector: string): T | null {
      if (selector === '.xterm') return xterm as T;
      if (selector === '.xterm-screen') return screen as T;
      return null;
    },
    getBoundingClientRect: () => ({ width: 818, height: 488 }),
  } as FakeElement;

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
    terminal,
  };
}

describe('fitSessionToScreen', () => {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    sessionTerminals.clear();
    mocks.refreshTerminalRenderer.mockClear();
    vi.mocked(sendResize).mockReset();
    $isMainBrowser.set(true);
    $currentSettings.set({
      fontSize: 14,
      fontFamily: 'Cascadia Code',
    } as never);
    dom.terminalsArea = {
      getBoundingClientRect: () => ({ width: 818, height: 488 }),
    } as HTMLElement;
    globalThis.document = {
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
  });

  afterEach(() => {
    sessionTerminals.clear();
    dom.terminalsArea = null;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    vi.clearAllMocks();
  });

  it('refreshes xterm renderer metrics before fitting the main-browser viewport', () => {
    const harness = createFitHarness();
    sessionTerminals.set('s1', harness.state as never);

    fitSessionToScreen('s1');

    expect(mocks.refreshTerminalRenderer).toHaveBeenCalledOnce();
    expect(harness.terminal.resize).toHaveBeenCalledWith(81, 24);
    expect(sendResize).toHaveBeenCalledWith('s1', 81, 24);
  });
});
