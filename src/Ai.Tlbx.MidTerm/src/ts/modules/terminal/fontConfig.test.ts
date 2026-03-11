import { describe, expect, it } from 'vitest';

import {
  buildTerminalFontStack,
  DEFAULT_TERMINAL_FONT_FAMILY,
  getBundledTerminalFontFamilies,
} from './fontConfig';

describe('fontConfig', () => {
  it('puts the selected font first in the terminal font stack', () => {
    expect(buildTerminalFontStack('JetBrains Mono')).toBe(
      "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
    );
  });

  it('preloads all bundled terminal fonts', () => {
    expect(getBundledTerminalFontFamilies()).toEqual([
      DEFAULT_TERMINAL_FONT_FAMILY,
      'JetBrains Mono',
      'Terminus',
    ]);
  });
});
