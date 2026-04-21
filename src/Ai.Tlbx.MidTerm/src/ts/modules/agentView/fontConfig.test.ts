import { describe, expect, it } from 'vitest';

import {
  buildAgentMessageFontStack,
  DEFAULT_AGENT_MESSAGE_FONT_FAMILY,
  getAgentMessageFontFamilies,
  normalizeAgentMessageFontFamily,
} from './fontConfig';

describe('agent fontConfig', () => {
  it('lists generic, UI, and bundled terminal font choices', () => {
    expect(getAgentMessageFontFamilies()).toEqual([
      DEFAULT_AGENT_MESSAGE_FONT_FAMILY,
      'sans',
      'serif',
      'Segoe UI',
      'Helvetica Neue',
      'Arial',
      'Verdana',
      'Tahoma',
      'Trebuchet MS',
      'Cascadia Code',
      'Cascadia Code SemiBold',
      'JetBrains Mono',
      'Terminus',
    ]);
  });

  it('normalizes configured font families to the supported canonical values', () => {
    expect(normalizeAgentMessageFontFamily('segoe ui')).toBe('Segoe UI');
    expect(normalizeAgentMessageFontFamily('  serif  ')).toBe('serif');
    expect(normalizeAgentMessageFontFamily('invalid')).toBe(DEFAULT_AGENT_MESSAGE_FONT_FAMILY);
  });

  it('builds CSS stacks for both UI and bundled monospace selections', () => {
    expect(buildAgentMessageFontStack('default')).toBe(
      "'Segoe UI Variable Text', 'Segoe UI', var(--font-ui)",
    );
    expect(buildAgentMessageFontStack('sans')).toBe('var(--font-ui)');
    expect(buildAgentMessageFontStack('Segoe UI')).toBe("'Segoe UI', var(--font-ui)");
    expect(buildAgentMessageFontStack('JetBrains Mono')).toContain("'JetBrains Mono'");
    expect(buildAgentMessageFontStack('JetBrains Mono')).toContain("'Segoe UI Emoji'");
  });
});
