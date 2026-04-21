import { describe, expect, it } from 'vitest';
import type { TerminalState } from '../../types';
import { isTerminalViewingScrollback } from './scrollback';

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
  it('returns true when the viewport is above live output', () => {
    expect(isTerminalViewingScrollback(makeState(120, 180))).toBe(true);
  });

  it('returns false when the viewport is at live output', () => {
    expect(isTerminalViewingScrollback(makeState(180, 180))).toBe(false);
  });
});
