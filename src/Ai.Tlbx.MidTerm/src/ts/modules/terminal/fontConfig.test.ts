import { describe, expect, it } from 'vitest';

import {
  buildTerminalFontStack,
  DEFAULT_TERMINAL_FONT_FAMILY,
  getBundledTerminalFontFamilies,
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
});
