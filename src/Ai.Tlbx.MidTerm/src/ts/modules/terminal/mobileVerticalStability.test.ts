import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionTerminals } from '../../state';
import {
  observeMobileVerticalViewportChange,
  rememberCurrentMobileViewportSnapshot,
  revealMobileStableTerminalCursor,
  resumeMobileStableTerminalCursorFollowing,
  setMobileVerticalStability,
} from './mobileVerticalStability';

function createState(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  cursorY: number,
) {
  const classes = new Set<string>();
  const rows = 10;
  const screen = { offsetHeight: scrollHeight, offsetTop: 0 };
  const container = {
    scrollTop,
    scrollHeight,
    clientHeight,
    dataset: {},
    querySelector: (selector: string) => (selector === '.xterm-screen' ? screen : null),
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  };
  return {
    container,
    terminal: {
      rows,
      buffer: { active: { cursorY } },
    },
  };
}

describe('mobile terminal vertical stability', () => {
  beforeEach(() => {
    sessionTerminals.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('window', {
      innerWidth: 390,
      matchMedia: vi.fn(() => ({ matches: true })),
      visualViewport: { width: 390, height: 430 },
    });
    vi.stubGlobal('document', {
      body: {
        classList: {
          contains: vi.fn(() => false),
          toggle: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    setMobileVerticalStability(false);
    sessionTerminals.clear();
    vi.unstubAllGlobals();
  });

  it('reveals the exact cursor row after mobile input without pinning the canvas bottom', () => {
    const state = createState(0, 200, 100, 5);
    sessionTerminals.set('s1', state as never);
    setMobileVerticalStability(true);
    state.container.scrollTop = 0;

    revealMobileStableTerminalCursor(state as never, { force: true });

    expect(state.container.scrollTop).toBe(28);
    expect(state.container.scrollTop).toBeLessThan(
      state.container.scrollHeight - state.container.clientHeight,
    );
  });

  it('does not steal manual browse position on output when the shell is away from bottom', () => {
    const state = createState(0, 200, 100, 9);
    sessionTerminals.set('s1', state as never);
    setMobileVerticalStability(true);
    state.container.scrollTop = 0;
    state.container.dataset.mobileCursorFollowing = 'false';

    revealMobileStableTerminalCursor(state as never);

    expect(state.container.scrollTop).toBe(0);
  });

  it('resumes cursor following on direct input without scrolling before terminal render', () => {
    const state = createState(0, 200, 100, 5);
    sessionTerminals.set('s1', state as never);
    setMobileVerticalStability(true);
    state.container.scrollTop = 0;
    state.container.dataset.mobileCursorFollowing = 'false';

    resumeMobileStableTerminalCursorFollowing(state as never);

    expect(state.container.dataset.mobileCursorFollowing).toBe('true');
    expect(state.container.scrollTop).toBe(0);
  });

  it('does not jump to the top or run queued cursor reveals after stability ends', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const state = createState(72, 200, 100, 9);
    sessionTerminals.set('s1', state as never);
    setMobileVerticalStability(true);
    while (callbacks.length > 0) {
      callbacks.shift()?.(0);
    }
    state.container.scrollTop = 72;

    revealMobileStableTerminalCursor(state as never, { force: true });
    setMobileVerticalStability(false, { preserveScrollPosition: true });
    callbacks.splice(0).forEach((callback) => callback(0));

    expect(state.container.scrollTop).toBe(72);
  });

  it('classifies a one-pixel keyboard height change as vertical-only', () => {
    rememberCurrentMobileViewportSnapshot();
    const viewport = window.visualViewport as VisualViewport;
    Object.defineProperty(viewport, 'height', { configurable: true, value: 429 });

    expect(observeMobileVerticalViewportChange()).toBe(true);
  });
});
