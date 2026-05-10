import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionTerminals } from '../../state';
import {
  pinMobileStableTerminalShellToBottom,
  setMobileVerticalStability,
} from './mobileVerticalStability';

function createContainer(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const classes = new Set<string>();
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    dataset: {},
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
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

  it('force-pins the stable terminal shell to the bottom after mobile input', () => {
    const container = createContainer(0, 240, 100);
    sessionTerminals.set('s1', { container } as never);
    setMobileVerticalStability(true);
    container.scrollTop = 0;

    pinMobileStableTerminalShellToBottom({ container } as never, { force: true });

    expect(container.scrollTop).toBe(240);
  });

  it('does not steal manual browse position on output when the shell is away from bottom', () => {
    const container = createContainer(0, 240, 100);
    sessionTerminals.set('s1', { container } as never);
    setMobileVerticalStability(true);
    container.scrollTop = 0;

    pinMobileStableTerminalShellToBottom({ container } as never);

    expect(container.scrollTop).toBe(0);
  });
});
