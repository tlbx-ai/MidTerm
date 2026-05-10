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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const button = createElement(['dev-soft-keyboard-toggle']);
    const keyboard = createElement();
    keyboard.hidden = true;
    const app = createElement(['terminal-page']);
    const body = createElement();
    const documentElement = createElement();
    const elements = new Map<string, ElementMock>([
      ['dev-soft-keyboard-toggle', button],
      ['dev-soft-keyboard', keyboard],
    ]);
    vi.stubGlobal('window', {
      innerHeight: 800,
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      mtDevSoftKeyboard: undefined,
    });
    vi.stubGlobal('document', {
      body,
      documentElement,
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => (selector === '.terminal-page' ? app : null),
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
};

function createElement(initialClasses: string[] = []): ElementMock {
  const classes = new Set(initialClasses);
  const attributes = new Map<string, string>();
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

  return {
    hidden: false,
    style,
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
    addEventListener: vi.fn(),
  };
}
