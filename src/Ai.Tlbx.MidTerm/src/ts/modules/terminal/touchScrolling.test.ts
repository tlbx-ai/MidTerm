import { describe, expect, it, vi } from 'vitest';

vi.mock('../touchController/detection', () => ({
  hasPrecisePointer: () => false,
  isTouchDevice: () => true,
}));

vi.mock('../comms/muxChannel', () => ({
  sendInput: vi.fn(),
}));

import { panMobileStableTerminalShellScroll, scrollViewport } from './touchScrolling';

function createShell(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const classes = new Set(['mobile-terminal-vertical-stable']);
  const container = {
    scrollTop,
    scrollHeight,
    clientHeight,
    classList: {
      contains: (name: string) => classes.has(name),
    },
  };

  return {
    container,
    state: {
      overlay: {
        parentElement: container,
      },
    },
  };
}

describe('mobile terminal touch scrolling', () => {
  it('pans the stable terminal shell without consuming xterm scrollback movement', () => {
    const { container, state } = createShell(20, 220, 100);

    const panned = panMobileStableTerminalShellScroll(state as never, 50);

    expect(container.scrollTop).toBe(70);
    expect(panned).toBe(50);
  });

  it('reports only the shell pan at the shell edge while xterm keeps the full drag delta', () => {
    const { container, state } = createShell(105, 220, 100);

    const panned = panMobileStableTerminalShellScroll(state as never, 50);

    expect(container.scrollTop).toBe(120);
    expect(panned).toBe(15);
  });

  it('passes the full drag delta through to xterm even when shell panning absorbs it', () => {
    const { container, state } = createShell(20, 220, 100);
    const terminal = { scrollLines: vi.fn() };
    const scrollState = {
      ...state,
      terminal,
      cellHeight: 10,
      scrollAccumulator: 0,
    };

    scrollViewport(scrollState as never, 50);

    expect(container.scrollTop).toBe(70);
    expect(terminal.scrollLines).toHaveBeenCalledWith(5);
  });
});
