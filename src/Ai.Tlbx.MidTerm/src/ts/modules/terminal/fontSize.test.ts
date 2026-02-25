import { describe, expect, it } from 'vitest';
import { MOBILE_BREAKPOINT } from '../../constants';
import { getEffectiveTerminalFontSize } from './fontSize';

describe('fontSize', () => {
  it('keeps configured font size on desktop', () => {
    expect(getEffectiveTerminalFontSize(14, MOBILE_BREAKPOINT + 1)).toBe(14);
  });

  it('uses 3px smaller font size on mobile', () => {
    expect(getEffectiveTerminalFontSize(14, MOBILE_BREAKPOINT)).toBe(11);
    expect(getEffectiveTerminalFontSize(14, MOBILE_BREAKPOINT - 1)).toBe(11);
  });

  it('clamps to a positive minimum', () => {
    expect(getEffectiveTerminalFontSize(1, MOBILE_BREAKPOINT)).toBe(1);
  });
});
