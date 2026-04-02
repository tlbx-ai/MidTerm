import { describe, expect, it } from 'vitest';

import {
  buildTerminalFontStack,
  DEFAULT_TERMINAL_FONT_FAMILY,
  getBundledTerminalFontFamilies,
  normalizeTerminalFontWeight,
  normalizeTerminalLetterSpacing,
} from './fontConfig';

describe('fontConfig', () => {
  it('puts the selected font first in the terminal font stack', () => {
    expect(buildTerminalFontStack('JetBrains Mono')).toBe(
      "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', monospace",
    );
  });

  it('preloads all bundled terminal fonts', () => {
    expect(getBundledTerminalFontFamilies()).toEqual([
      DEFAULT_TERMINAL_FONT_FAMILY,
      'JetBrains Mono',
      'Terminus',
    ]);
  });

  it('includes explicit emoji fallbacks in the font stack', () => {
    const stack = buildTerminalFontStack('Cascadia Code');

    expect(stack).toContain("'Segoe UI Emoji'");
    expect(stack).toContain("'Apple Color Emoji'");
    expect(stack).toContain("'Noto Color Emoji'");
    expect(stack).toContain("'Segoe UI Symbol'");
  });

  it('normalizes font weights to the supported bundled variants', () => {
    expect(normalizeTerminalFontWeight('100')).toBe('normal');
    expect(normalizeTerminalFontWeight('500')).toBe('normal');
    expect(normalizeTerminalFontWeight('700')).toBe('bold');
    expect(normalizeTerminalFontWeight('900')).toBe('bold');
  });

  it('rounds letter spacing to whole pixels within xterm bounds', () => {
    expect(normalizeTerminalLetterSpacing(0.49)).toBe(0);
    expect(normalizeTerminalLetterSpacing(0.5)).toBe(1);
    expect(normalizeTerminalLetterSpacing(-2.4)).toBe(-2);
    expect(normalizeTerminalLetterSpacing(10.2)).toBe(10);
  });
});
