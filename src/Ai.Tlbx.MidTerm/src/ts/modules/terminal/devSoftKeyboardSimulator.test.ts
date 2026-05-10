import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const autoResizeAllTerminalsImmediate = vi.fn();
const rescaleAllTerminalsImmediate = vi.fn();
const setMobileVerticalStability = vi.fn();

vi.mock('../../stores', () => ({
  $isMainBrowser: { get: () => true },
}));

vi.mock('./scaling', () => ({
  autoResizeAllTerminalsImmediate,
  rescaleAllTerminalsImmediate,
}));

vi.mock('./mobileVerticalStability', () => ({
  setMobileVerticalStability,
}));

describe('dev soft keyboard simulator', () => {
  let selectorResults: Map<string, unknown>;
  let windowListeners: Map<string, EventListener[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const button = createElement(['dev-soft-keyboard-toggle']);
    const keyboard = createElement();
    keyboard.hidden = true;
    const app = createElement(['terminal-page']);
    const body = createElement();
    const documentElement = createElement();
    selectorResults = new Map<string, unknown>([['.terminal-page', app]]);
    windowListeners = new Map<string, EventListener[]>();
    const elements = new Map<string, ElementMock>([
      ['dev-soft-keyboard-toggle', button],
      ['dev-soft-keyboard', keyboard],
    ]);
    vi.stubGlobal('window', {
      innerHeight: 800,
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        const existing = windowListeners.get(name) ?? [];
        existing.push(listener);
        windowListeners.set(name, existing);
      }),
      dispatchEvent: vi.fn(),
      mtDevSoftKeyboard: undefined,
    });
    vi.stubGlobal('document', {
      body,
      documentElement,
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => selectorResults.get(selector) ?? null,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('simulates soft-keyboard viewport pressure from the web preview toolbar button', async () => {
    const { initDevSoftKeyboardSimulator } = await import('./devSoftKeyboardSimulator');

    initDevSoftKeyboardSimulator();
    window.mtDevSoftKeyboard?.show(300);

    expect(document.getElementById('dev-soft-keyboard-toggle')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(document.getElementById('dev-soft-keyboard')?.hidden).toBe(false);
    expect(document.body.classList.contains('keyboard-visible')).toBe(true);
    expect(document.body.classList.contains('mobile-terminal-vertical-stable')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--midterm-soft-keyboard-height')).toBe(
      '300px',
    );
    expect(document.querySelector<HTMLElement>('.terminal-page')?.style.height).toBe('500px');
    expect(setMobileVerticalStability).toHaveBeenCalledWith(true);
    expect(autoResizeAllTerminalsImmediate).toHaveBeenCalled();
  });

  it('hides the simulator and restores viewport pressure', async () => {
    const { initDevSoftKeyboardSimulator } = await import('./devSoftKeyboardSimulator');

    initDevSoftKeyboardSimulator();
    window.mtDevSoftKeyboard?.show(260);
    window.mtDevSoftKeyboard?.hide();

    expect(document.getElementById('dev-soft-keyboard-toggle')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(document.getElementById('dev-soft-keyboard')?.hidden).toBe(true);
    expect(document.body.classList.contains('keyboard-visible')).toBe(false);
    expect(document.querySelector<HTMLElement>('.terminal-page')?.style.height).toBe('');
    expect(setMobileVerticalStability).toHaveBeenLastCalledWith(false);
  });

  it('routes the parent toolbar button to the active preview tab keyboard only', async () => {
    const { initDevSoftKeyboardSimulator } = await import('./devSoftKeyboardSimulator');
    const button = document.getElementById('dev-soft-keyboard-toggle') as ElementMock;
    const tabAKeyboard = {
      show: vi.fn(),
      hide: vi.fn(),
      toggle: vi.fn(),
      isActive: vi.fn(() => true),
    };
    const tabBKeyboard = {
      show: vi.fn(),
      hide: vi.fn(),
      toggle: vi.fn(),
      isActive: vi.fn(() => false),
    };
    const tabAFrame = createElement() as ElementMock & {
      contentWindow: Window;
    };
    tabAFrame.dataset.previewFrameKey = 'tab-a';
    tabAFrame.contentWindow = { mtDevSoftKeyboard: tabAKeyboard } as unknown as Window;
    const tabBFrame = createElement() as ElementMock & {
      contentWindow: Window;
    };
    tabBFrame.dataset.previewFrameKey = 'tab-b';
    tabBFrame.contentWindow = { mtDevSoftKeyboard: tabBKeyboard } as unknown as Window;

    selectorResults.set('.web-preview-iframe:not(.hidden)', tabAFrame);
    initDevSoftKeyboardSimulator();
    button.dispatch('click');

    expect(tabAKeyboard.toggle).toHaveBeenCalledTimes(1);
    expect(tabBKeyboard.toggle).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-pressed')).toBe('true');

    selectorResults.set('.web-preview-iframe:not(.hidden)', tabBFrame);
    dispatchWindowEvent('midterm:web-preview-active-tab-changed');

    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps fallback keyboard state per preview tab', async () => {
    const { initDevSoftKeyboardSimulator } = await import('./devSoftKeyboardSimulator');
    const button = document.getElementById('dev-soft-keyboard-toggle') as ElementMock;
    const keyboard = document.getElementById('dev-soft-keyboard') as ElementMock;
    const previewBody = createElement(['web-preview-dock-body']);
    const tabAFrame = createElement() as ElementMock & {
      contentWindow: Window;
    };
    tabAFrame.dataset.previewFrameKey = 'tab-a';
    tabAFrame.contentWindow = {} as Window;
    const tabBFrame = createElement() as ElementMock & {
      contentWindow: Window;
    };
    tabBFrame.dataset.previewFrameKey = 'tab-b';
    tabBFrame.contentWindow = {} as Window;

    selectorResults.set('.web-preview-dock-body', previewBody);
    selectorResults.set('.web-preview-iframe:not(.hidden)', tabAFrame);
    initDevSoftKeyboardSimulator();
    button.dispatch('click');

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(keyboard.hidden).toBe(false);

    selectorResults.set('.web-preview-iframe:not(.hidden)', tabBFrame);
    dispatchWindowEvent('midterm:web-preview-active-tab-changed');

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(keyboard.hidden).toBe(true);

    selectorResults.set('.web-preview-iframe:not(.hidden)', tabAFrame);
    dispatchWindowEvent('midterm:web-preview-active-tab-changed');

    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(keyboard.hidden).toBe(false);
  });

  function dispatchWindowEvent(name: string): void {
    for (const listener of windowListeners.get(name) ?? []) {
      listener(new Event(name));
    }
  }
});

type StyleMock = Record<string, string> & {
  setProperty: (name: string, value: string) => void;
  getPropertyValue: (name: string) => string;
  removeProperty: (name: string) => void;
};

type ElementMock = {
  hidden: boolean;
  style: StyleMock;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => boolean;
  };
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | undefined;
  addEventListener: (name: string, listener: EventListener) => void;
  appendChild: (child: ElementMock) => void;
  parentElement: ElementMock | null;
  dataset: Record<string, string>;
  dispatch: (name: string) => void;
};

function createElement(initialClasses: string[] = []): ElementMock {
  const classes = new Set(initialClasses);
  const attributes = new Map<string, string>();
  const listeners = new Map<string, EventListener[]>();
  const style = {
    setProperty(name: string, value: string) {
      style[name] = value;
    },
    getPropertyValue(name: string) {
      return style[name] ?? '';
    },
    removeProperty(name: string) {
      delete style[name];
    },
  } as StyleMock;

  const element: ElementMock = {
    hidden: false,
    style,
    parentElement: null,
    dataset: {},
    classList: {
      add: (...names: string[]) => {
        for (const name of names) classes.add(name);
      },
      remove: (...names: string[]) => {
        for (const name of names) classes.delete(name);
      },
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !classes.has(name);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return enabled;
      },
    },
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      const existing = listeners.get(name) ?? [];
      existing.push(listener);
      listeners.set(name, existing);
    }),
    appendChild: vi.fn((child: ElementMock) => {
      child.parentElement = element;
    }),
    dispatch: (name: string) => {
      for (const listener of listeners.get(name) ?? []) {
        listener(new Event(name));
      }
    },
  };

  return element;
}
