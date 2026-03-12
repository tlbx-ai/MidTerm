import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalState } from '../../types';

let isTerminalViewingScrollback: typeof import('./scaling').isTerminalViewingScrollback;

function makeState(viewportY: number, baseY: number): Pick<TerminalState, 'terminal'> {
  return {
    terminal: {
      buffer: {
        active: {
          viewportY,
          baseY,
        },
      },
    },
  } as unknown as Pick<TerminalState, 'terminal'>;
}

describe('isTerminalViewingScrollback', () => {
  beforeAll(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });

    ({ isTerminalViewingScrollback } = await import('./scaling'));
  });

  it('returns true when the viewport is above live output', () => {
    expect(isTerminalViewingScrollback(makeState(120, 180))).toBe(true);
  });

  it('returns false when the viewport is at live output', () => {
    expect(isTerminalViewingScrollback(makeState(180, 180))).toBe(false);
  });
});
