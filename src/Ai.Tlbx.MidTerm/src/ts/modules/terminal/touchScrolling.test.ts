import { describe, expect, it, vi } from 'vitest';

vi.mock('../touchController/detection', () => ({
  hasPrecisePointer: () => false,
  isTouchDevice: () => true,
}));

vi.mock('../comms/muxChannel', () => ({
  sendInput: vi.fn(),
}));

import { consumeMobileStableTerminalShellScroll } from './touchScrolling';

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
  it('pans the stable terminal shell before consuming xterm scrollback movement', () => {
    const { container, state } = createShell(20, 220, 100);

    const remaining = consumeMobileStableTerminalShellScroll(state as never, 50);

    expect(container.scrollTop).toBe(70);
    expect(remaining).toBe(0);
  });

  it('passes leftover drag distance to xterm scrollback at the shell edge', () => {
    const { container, state } = createShell(105, 220, 100);

    const remaining = consumeMobileStableTerminalShellScroll(state as never, 50);

    expect(container.scrollTop).toBe(120);
    expect(remaining).toBe(35);
  });
});
